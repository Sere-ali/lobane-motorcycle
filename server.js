const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const sharp = require('sharp');
const compression = require('compression');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, seed, TYPES, DATA_DIR, backup, storageIsPersistent } = require('./db');
const V = require('./views');
const { esc, fcfa, digits, layout, motoCard, filterForm, motoForm, motoImg, typeIcon } = V;

const PROD = process.env.NODE_ENV === 'production';
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---- secret de session (persisté) ----
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  const f = path.join(DATA_DIR, '.secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  SECRET = fs.readFileSync(f, 'utf8');
}
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
// Empreinte du mot de passe dans le jeton : changer de mot de passe déconnecte toutes les anciennes sessions.
const pwStamp = (hash) => crypto.createHash('sha256').update(String(hash)).digest('hex').slice(0, 12);
const makeToken = (u) => {
  const exp = Date.now() + 1000 * 60 * 60 * 8; // 8 h
  const p = `${u.id}.${exp}.${pwStamp(u.password_hash)}`;
  return `${p}.${sign(p)}`;
};
function readToken(t) {
  if (!t) return null;
  const [uid, exp, stamp, sig] = String(t).split('.');
  if (!uid || !exp || !stamp || !sig) return null;
  const expect = sign(`${uid}.${exp}.${stamp}`);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  if (Number(exp) < Date.now()) return null;
  return { uid: Number(uid), stamp };
}
const DUMMY_HASH = bcrypt.hashSync('lobane-dummy', 10); // temps de réponse constant si l'e-mail est inconnu

// ---- limitation simple de débit ----
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(compression());
// vérification de santé pour Render (aucune session, aucune écriture)
app.get('/healthz', (req, res) => {
  try { db.prepare('SELECT 1').get(); res.type('text/plain').send('ok'); } catch (e) { res.status(500).type('text/plain').send('db'); }
});
// journal des requêtes (pages et actions, pas les fichiers statiques)
app.use((req, res, next) => {
  if (/\.(css|js|png|jpe?g|webp|ico|svg|woff2?)$/i.test(req.path) || req.path.startsWith('/uploads/')) return next();
  const t = Date.now();
  res.on('finish', () => console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`));
  next();
});
app.use((req, res, next) => {
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'; object-src 'none'");
  if (req.method === 'GET' && /^\/(admin|super|connexion)/.test(req.path)) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /admin\nDisallow: /super\nDisallow: /connexion\n'));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true, setHeaders: (r) => r.setHeader('Content-Disposition', 'inline') }));

// protection CSRF : l'origine doit correspondre à l'hôte
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const src = req.get('origin') || req.get('referer');
  if (src) { try { if (new URL(src).host !== req.get('host')) return res.status(403).send('Requête refusée.'); } catch { return res.status(403).send('Requête refusée.'); } }
  next();
});

// utilisateur courant + messages flash
app.use((req, res, next) => {
  const tok = readToken(req.cookies.sid);
  const u = tok ? db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(tok.uid) : null;
  req.user = u && pwStamp(u.password_hash) === tok.stamp ? u : null;
  const f = req.cookies.flash;
  if (f) { try { res.locals.flash = JSON.parse(Buffer.from(f, 'base64').toString()); } catch {} res.clearCookie('flash'); }
  res.locals.render = (opts) => res.send(layout({ user: req.user, flash: res.locals.flash, ...opts }));
  next();
});
const flash = (res, type, msg) => res.cookie('flash', Buffer.from(JSON.stringify({ type, msg })).toString('base64'), { httpOnly: true, sameSite: 'lax', maxAge: 15000 });

const requireAuth = (req, res, next) => (req.user ? next() : res.redirect('/connexion'));
const requireSuper = (req, res, next) => (req.user && req.user.role === 'super' ? next() : res.status(403).send(layout({ title: 'Accès refusé', user: req.user, body: '<section><div class="wrap"><h2>Accès refusé</h2><p class="sub">Cette page est réservée au super administrateur.</p></div></section>' })));

// ---- envoi de fichiers ----
const EXT = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1 };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, !!EXT[file.mimetype]),
});
const rmFile = (name) => { if (name && /^[a-f0-9]+\.(jpg|png|webp)$/.test(name)) fs.rm(path.join(UPLOAD_DIR, name), { force: true }, () => {}); };
// Redimensionne et convertit en WebP (photos légères pour les téléphones). Sharp refuse aussi tout fichier qui n'est pas une vraie image.
const handleUpload = (req, res, next) => upload.single('image')(req, res, async (err) => {
  const back = req.get('referer') || '/';
  if (err) { flash(res, 'err', err.code === 'LIMIT_FILE_SIZE' ? 'Photo trop lourde (5 Mo maximum).' : 'Erreur lors de l\'envoi de la photo.'); return res.redirect(back); }
  if (req.file) {
    const name = crypto.randomBytes(12).toString('hex') + '.webp';
    try {
      await sharp(req.file.buffer, { limitInputPixels: 50e6 }).rotate()
        .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 }).toFile(path.join(UPLOAD_DIR, name));
      req.file.filename = name; req.file.buffer = null;
    } catch (e) { req.file = null; flash(res, 'err', 'Fichier image invalide.'); return res.redirect(back); }
  }
  next();
});

// ---- helpers de données ----
const PER_PAGE = 12;
const PUBLIC_MOTOS = `FROM motos m JOIN users u ON u.id=m.user_id WHERE u.active=1`;
const shopsList = () => db.prepare(`SELECT id, shop_name FROM users WHERE active=1 AND (role='admin' OR EXISTS(SELECT 1 FROM motos WHERE user_id=users.id)) ORDER BY shop_name`).all();

function parseMoto(b) {
  const title = String(b.title || '').trim().slice(0, 120);
  const type = TYPES.includes(b.type) ? b.type : null;
  const price = Math.round(Number(b.price));
  const status = b.status === 'vendu' ? 'vendu' : 'disponible';
  if (!title || !type || !Number.isFinite(price) || price < 0 || price > 1e9) return null;
  return { title, type, price, status, brand: String(b.brand || '').trim().slice(0, 60), description: String(b.description || '').trim().slice(0, 2000) };
}

// ================= SITE PUBLIC =================
app.get('/', (req, res) => {
  const latest = db.prepare(`SELECT m.*, u.shop_name ${PUBLIC_MOTOS} ORDER BY m.id DESC LIMIT 6`).all();
  const star = db.prepare(`SELECT m.*, u.shop_name ${PUBLIC_MOTOS} AND m.image IS NOT NULL AND m.status='disponible' ORDER BY m.id DESC LIMIT 1`).get();
  const nm = db.prepare(`SELECT COUNT(*) c ${PUBLIC_MOTOS}`).get().c;
  const ns = db.prepare(`SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1`).get().c;
  const counts = Object.fromEntries(db.prepare(`SELECT m.type t, COUNT(*) c ${PUBLIC_MOTOS} GROUP BY m.type`).all().map((r) => [r.t, r.c]));
  const ribbon = ['Vente de moto et pièces détachées', 'Super 2016 Power', 'Abidjan · Koumassi · 3 Ampoules', 'Motos de qualité à prix abordables'];
  const half = [...ribbon, ...ribbon].map((t) => `<span>${esc(t)}</span>`).join('');
  res.locals.render({
    title: 'Lobane Motorcycle – Vente de motos et pièces détachées à Abidjan',
    desc: 'Achetez votre moto à Abidjan : catalogue de motos neuves, pièces détachées et équipements de plusieurs boutiques.',
    page: 'home',
    body: `
<div class="hero"><div class="wrap">
  <div class="hero-copy">
    <span class="tag">Super 2016 Power</span>
    <h1>Le meilleur vendeur de <em>motos</em> en Côte d'Ivoire</h1>
    <p class="lead">Comparez les motos de nos boutiques à Abidjan : motos de qualité, pièces premium, équipements et assurances.</p>
    <div class="cta"><a class="btn" href="/motos">Voir toutes les motos <span class="arr">→</span></a><a class="btn alt" href="tel:+2250505137178">📞 05 05 13 71 78</a></div>
  </div>
  <div class="heroart">
    <a class="heroart-card" href="${star ? '/moto/' + star.id : '/motos'}" aria-label="${star ? esc(star.title) : 'Voir les motos'}">${star ? motoImg(star, true) : '<img src="/img/demo/honda-winner-r-2026.jpg" width="1200" height="1000" alt="Honda Winner R 2026" fetchpriority="high">'}</a>
    ${star ? `<span class="chip new">À la une · ${esc(star.brand || star.type)}</span><span class="chip price">${fcfa(star.price)}</span>` : '<span class="chip new">Nouveauté · Honda Winner R</span>'}
  </div>
</div></div>
<div class="stats"><div class="wrap">
  <div><strong data-count="${nm}">${nm}</strong><span>Motos en ligne</span></div>
  <div><strong data-count="${ns}">${ns}</strong><span>Boutiques partenaires</span></div>
  <div><strong data-count="2016">2016</strong><span>Début de l'aventure</span></div>
  <div><strong data-count="458" data-suffix=" K">458 K</strong><span>Abonnés TikTok</span></div></div></div>
<div class="ribbon" aria-hidden="true"><div class="ribbon-track">${half}${half}</div></div>
<section><div class="wrap"><h2 class="reveal">Parcourir par type</h2><p class="sub reveal">Choisissez la catégorie qui vous correspond.</p>
  <div class="grid g3">${TYPES.map((t) => `<a class="card type reveal" href="/motos?type=${encodeURIComponent(t)}">${typeIcon(t)}<span><b>${esc(t)}</b><small>${counts[t] || 0} annonce${(counts[t] || 0) > 1 ? 's' : ''}</small></span></a>`).join('')}</div></div></section>
<section class="alt-bg"><div class="wrap"><h2 class="reveal">Dernières annonces</h2><p class="sub reveal">Les motos récemment ajoutées par nos boutiques.</p>
  ${latest.length ? `<div class="grid g3">${latest.map(motoCard).join('')}</div>` : '<div class="empty">Aucune moto en ligne pour le moment.</div>'}
  <p style="margin-top:28px" class="reveal"><a class="btn" href="/motos">Voir tout le catalogue <span class="arr">→</span></a></p></div></section>
<section><div class="wrap about">
  <div class="banner reveal left"><img src="/img/logo-banner.jpg" width="1079" height="406" alt="Lobane Motorcycle – vente de moto et pièces détachées" loading="lazy"></div>
  <div class="reveal right"><h2>Pourquoi Lobane ?</h2><ul class="points">
    <li><span><b>Motos de qualité</b> à des prix abordables.</span></li>
    <li><span><b>Pièces détachées premium</b> pour toutes vos réparations.</span></li>
    <li><span><b>Tout en un</b> : moto, équipement, assurance.</span></li>
    <li><span><b>Livraison</b> de pneus disponible.</span></li></ul></div>
</div></section>
<section class="alt-bg"><div class="wrap" style="max-width:680px"><h2 class="reveal">Une question ?</h2><p class="sub reveal">Laissez-nous votre demande, on vous rappelle.</p>
  <form class="stack panel reveal" method="post" action="/demande">
    <label>Votre nom<input name="name" required maxlength="80" autocomplete="name"></label>
    <label>Téléphone<input name="phone" required maxlength="30" inputmode="tel" autocomplete="tel"></label>
    <label>Je cherche…<select name="subject"><option>Une moto</option><option>Des pièces détachées</option><option>Des équipements</option><option>Une assurance</option></select></label>
    <label>Message<textarea name="message" rows="4" maxlength="1000"></textarea></label>
    <button class="btn red" type="submit">Envoyer ma demande</button></form></div></section>`,
  });
});

app.get('/motos', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  const type = TYPES.includes(req.query.type) ? req.query.type : '';
  const shop = /^\d+$/.test(req.query.shop || '') ? req.query.shop : '';
  const min = /^\d+$/.test(req.query.min || '') ? req.query.min : '';
  const max = /^\d+$/.test(req.query.max || '') ? req.query.max : '';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const where = []; const args = [];
  if (q) { where.push('(m.title LIKE ? OR m.brand LIKE ? OR m.description LIKE ?)'); const l = `%${q.replace(/[%_]/g, '')}%`; args.push(l, l, l); }
  if (type) { where.push('m.type=?'); args.push(type); }
  if (shop) { where.push('m.user_id=?'); args.push(Number(shop)); }
  if (min) { where.push('m.price>=?'); args.push(Number(min)); }
  if (max) { where.push('m.price<=?'); args.push(Number(max)); }
  const cond = where.length ? ' AND ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c ${PUBLIC_MOTOS}${cond}`).get(...args).c;
  const rows = db.prepare(`SELECT m.*, u.shop_name ${PUBLIC_MOTOS}${cond} ORDER BY m.status='vendu', m.id DESC LIMIT ? OFFSET ?`).all(...args, PER_PAGE, (page - 1) * PER_PAGE);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const qs = (p) => new URLSearchParams({ q, type, shop, min, max, page: p }).toString();
  res.locals.render({
    title: 'Toutes les motos – Lobane Motorcycle',
    body: `<section><div class="wrap"><h2>Nos motos</h2><p class="sub">${total} annonce${total > 1 ? 's' : ''} trouvée${total > 1 ? 's' : ''}.</p>
    ${filterForm({ q, type, shop, min, max }, shopsList())}
    ${rows.length ? `<div class="grid g3">${rows.map(motoCard).join('')}</div>` : '<div class="empty">Aucune moto ne correspond à votre recherche.</div>'}
    ${pages > 1 ? `<p class="pager">${page > 1 ? `<a class="btn alt sm" href="/motos?${qs(page - 1)}">← Précédent</a>` : ''}<span>Page ${page} / ${pages}</span>${page < pages ? `<a class="btn alt sm" href="/motos?${qs(page + 1)}">Suivant →</a>` : ''}</p>` : ''}
    </div></section>`,
  });
});

app.get('/moto/:id(\\d+)', (req, res) => {
  const m = db.prepare(`SELECT m.*, u.shop_name, u.phone, u.whatsapp ${PUBLIC_MOTOS} AND m.id=?`).get(req.params.id);
  if (!m) return res.status(404).send(layout({ title: 'Introuvable', user: req.user, body: '<section><div class="wrap"><h2>Annonce introuvable</h2><p class="sub">Cette moto n\'existe plus ou n\'est plus en ligne.</p><a class="btn" href="/motos">Voir les motos</a></div></section>' }));
  const tel = m.phone || '+2250505137178'; const wa = digits(m.whatsapp || m.phone) || '2250505137178';
  const msg = encodeURIComponent(`Bonjour, je suis intéressé(e) par la moto « ${m.title} » (${fcfa(m.price)}) vue sur le site Lobane Motorcycle.`);
  res.locals.render({
    title: `${m.title} – ${m.shop_name} – Lobane Motorcycle`,
    desc: `${m.title} à ${fcfa(m.price)} chez ${m.shop_name}, Abidjan.`,
    body: `<section><div class="wrap">
    <p class="crumbs"><a href="/">Accueil</a><span>›</span><a href="/motos">Motos</a><span>›</span><a href="/motos?type=${encodeURIComponent(m.type)}">${esc(m.type)}</a></p>
    <div class="detail"><div class="imgbox">${motoImg(m)}${m.status === 'vendu' ? '<span class="soldtag">Vendu</span>' : ''}</div>
    <div><span class="tag">${esc(m.type)}</span><h1>${esc(m.title)}</h1><span class="price">${fcfa(m.price)}</span>
      <ul class="meta"><li>🏪 Boutique : <b>${esc(m.shop_name)}</b></li>${m.brand ? `<li>🏷️ Marque : <b>${esc(m.brand)}</b></li>` : ''}<li>📌 Statut : <b>${m.status === 'vendu' ? 'Vendu' : 'Disponible'}</b></li></ul>
      ${m.description ? `<p>${esc(m.description).replace(/\n/g, '<br>')}</p>` : ''}
      <div class="box contactbox"><b>Intéressé(e) ? Contactez ${esc(m.shop_name)}</b>
        <div class="cta"><a class="btn" href="tel:${esc(tel)}">📞 Appeler</a><a class="btn wa" href="https://wa.me/${wa}?text=${msg}" target="_blank" rel="noopener">💬 WhatsApp</a></div></div>
      <form class="stack panel" style="margin-top:18px" method="post" action="/moto/${m.id}/demande"><b>Ou laissez votre numéro, on vous rappelle</b>
        <label>Votre nom<input name="name" required maxlength="80"></label><label>Téléphone<input name="phone" required maxlength="30" inputmode="tel"></label>
        <label>Message (facultatif)<textarea name="message" rows="3" maxlength="1000"></textarea></label><button class="btn red" type="submit">Envoyer</button></form>
    </div></div></div></section>`,
  });
});

function saveInquiry(req, res, shopId, motoId, back) {
  if (limited(`inq:${req.ip}`, 5, 10 * 60e3)) { flash(res, 'err', 'Trop de demandes. Réessayez dans quelques minutes.'); return res.redirect(back); }
  const name = String(req.body.name || '').trim().slice(0, 80); const phone = String(req.body.phone || '').trim().slice(0, 30);
  if (!name || digits(phone).length < 8) { flash(res, 'err', 'Merci d\'indiquer votre nom et un numéro de téléphone valide.'); return res.redirect(back); }
  db.prepare('INSERT INTO inquiries (shop_id,moto_id,name,phone,subject,message) VALUES (?,?,?,?,?,?)')
    .run(shopId, motoId, name, phone, String(req.body.subject || '').slice(0, 60), String(req.body.message || '').trim().slice(0, 1000));
  flash(res, 'ok', 'Merci ! Votre demande a bien été envoyée, nous vous rappelons rapidement.');
  res.redirect(back);
}
app.post('/demande', (req, res) => saveInquiry(req, res, db.prepare("SELECT id FROM users WHERE role='super' LIMIT 1").get()?.id ?? null, null, '/'));
app.post('/moto/:id(\\d+)/demande', (req, res) => {
  const m = db.prepare(`SELECT m.id, m.user_id ${PUBLIC_MOTOS} AND m.id=?`).get(req.params.id);
  if (!m) return res.redirect('/motos');
  saveInquiry(req, res, m.user_id, m.id, `/moto/${m.id}`);
});

// ================= AUTHENTIFICATION =================
app.get('/connexion', (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'super' ? '/super' : '/admin');
  res.locals.render({ title: 'Connexion – Espace boutique', body: `<section><div class="wrap narrow"><h2 class="reveal">Espace boutique</h2><p class="sub reveal">Gérants de boutique : connectez-vous pour publier et gérer vos annonces de motos.</p>
  <form class="stack panel" method="post" action="/connexion"><label>E-mail<input type="email" name="email" required autocomplete="username"></label>
  <label>Mot de passe<input type="password" name="password" required autocomplete="current-password"></label><button class="btn" type="submit">Se connecter</button></form></div></section>` });
});
app.post('/connexion', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (limited(`login:${req.ip}`, 10, 15 * 60e3) || limited(`loginu:${email}`, 8, 15 * 60e3)) { flash(res, 'err', 'Trop de tentatives. Réessayez dans 15 minutes.'); return res.redirect('/connexion'); }
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  const ok = bcrypt.compareSync(String(req.body.password || ''), u ? u.password_hash : DUMMY_HASH) && !!u;
  if (!ok) { flash(res, 'err', 'E-mail ou mot de passe incorrect.'); return res.redirect('/connexion'); }
  if (!u.active) { flash(res, 'err', 'Ce compte est suspendu. Contactez Lobane Motorcycle.'); return res.redirect('/connexion'); }
  res.cookie('sid', makeToken(u), { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 8 * 3600e3 });
  res.redirect(u.role === 'super' ? '/super' : '/admin');
});
app.post('/deconnexion', (req, res) => { res.clearCookie('sid'); res.redirect('/'); });

// ================= ESPACE BOUTIQUE =================
const statusPill = (s) => `<span class="pill ${s === 'vendu' ? 'sold' : 'on'}">${s === 'vendu' ? 'Vendu' : 'Disponible'}</span>`;

app.get('/admin', requireAuth, (req, res) => {
  if (req.user.role === 'super') return res.redirect('/super');
  const motos = db.prepare('SELECT * FROM motos WHERE user_id=? ORDER BY id DESC').all(req.user.id);
  const inq = db.prepare('SELECT i.*, m.title FROM inquiries i LEFT JOIN motos m ON m.id=i.moto_id WHERE i.shop_id=? ORDER BY i.id DESC LIMIT 20').all(req.user.id);
  res.locals.render({ title: 'Mon espace boutique', body: `<section><div class="wrap">
  <div class="dash-head"><div><span class="tag">Espace gérant</span><h2 style="margin-top:12px">${esc(req.user.shop_name)}</h2><p class="sub" style="margin:10px 0 0">C'est vous qui publiez les annonces de votre boutique. Elles apparaissent sur le site avec le nom de votre boutique.</p></div><div class="actions"><a class="btn" href="/admin/moto/nouvelle">+ Publier une annonce</a><a class="btn alt" href="/admin/profil">Mon profil</a></div></div>
  <div class="kpis"><div class="kpi reveal"><strong data-count="${motos.length}">${motos.length}</strong><span>Annonces publiées</span></div><div class="kpi reveal"><strong data-count="${motos.filter((m) => m.status === 'disponible').length}">${motos.filter((m) => m.status === 'disponible').length}</strong><span>Disponibles</span></div><div class="kpi reveal"><strong data-count="${motos.filter((m) => m.status === 'vendu').length}">${motos.filter((m) => m.status === 'vendu').length}</strong><span>Vendues</span></div><div class="kpi reveal"><strong data-count="${inq.length}">${inq.length}</strong><span>Demandes reçues</span></div></div>
  <h3 class="sec">Mes motos</h3>
  ${motos.length ? `<div class="tablewrap"><table><tr><th></th><th>Moto</th><th>Type</th><th>Prix</th><th>Statut</th><th></th></tr>${motos.map((m) => `<tr><td>${m.image ? `<img class="thumb" src="/uploads/${esc(m.image)}" alt="">` : ''}</td><td><a href="/moto/${m.id}"><b>${esc(m.title)}</b></a></td><td>${esc(m.type)}</td><td>${fcfa(m.price)}</td><td>${statusPill(m.status)}</td>
  <td><div class="actions"><a class="btn alt sm" href="/admin/moto/${m.id}/modifier">Modifier</a><form method="post" action="/admin/moto/${m.id}/supprimer" data-confirm="Supprimer cette moto ?"><button class="btn danger sm">Supprimer</button></form></div></td></tr>`).join('')}</table></div>` : '<div class="empty" style="margin-bottom:28px">Vous n\'avez pas encore publié de moto.</div>'}
  <h3 class="sec">Dernières demandes</h3>
  ${inq.length ? `<div class="tablewrap"><table><tr><th>Date</th><th>Nom</th><th>Téléphone</th><th>Moto</th><th>Message</th></tr>${inq.map((i) => `<tr><td>${esc(i.created_at.slice(0, 16))}</td><td>${esc(i.name)}</td><td><a href="tel:${esc(i.phone)}">${esc(i.phone)}</a></td><td>${esc(i.title || '—')}</td><td>${esc(i.message || '')}</td></tr>`).join('')}</table></div>` : '<div class="empty">Aucune demande pour le moment.</div>'}
  </div></section>` });
});

app.get('/admin/moto/nouvelle', requireAuth, (req, res) => {
  res.locals.render({ title: 'Ajouter une moto', body: `<section><div class="wrap narrow" style="max-width:640px"><h2>Ajouter une moto</h2><p class="sub">Boutique : <b>${esc(req.user.shop_name)}</b></p><div class="panel">${motoForm({}, '/admin/moto/nouvelle', 'Publier la moto')}</div></div></section>` });
});
app.post('/admin/moto/nouvelle', requireAuth, handleUpload, (req, res) => {
  const d = parseMoto(req.body);
  if (!d) { if (req.file) rmFile(req.file.filename); flash(res, 'err', 'Vérifiez le nom, le type et le prix.'); return res.redirect('/admin/moto/nouvelle'); }
  db.prepare('INSERT INTO motos (user_id,title,brand,type,price,description,image,status) VALUES (?,?,?,?,?,?,?,?)')
    .run(req.user.id, d.title, d.brand, d.type, d.price, d.description, req.file?.filename || null, d.status);
  flash(res, 'ok', 'Moto publiée.'); res.redirect(req.user.role === 'super' ? '/super' : '/admin');
});

function ownMoto(req, res) {
  const m = db.prepare('SELECT m.*, u.shop_name FROM motos m JOIN users u ON u.id=m.user_id WHERE m.id=?').get(req.params.id);
  if (!m || (req.user.role !== 'super' && m.user_id !== req.user.id)) { res.status(404).send(layout({ title: 'Introuvable', user: req.user, body: '<section><div class="wrap"><h2>Moto introuvable</h2></div></section>' })); return null; }
  return m;
}
app.get('/admin/moto/:id(\\d+)/modifier', requireAuth, (req, res) => {
  const m = ownMoto(req, res); if (!m) return;
  res.locals.render({ title: 'Modifier la moto', body: `<section><div class="wrap narrow" style="max-width:640px"><h2>Modifier la moto</h2><p class="sub">Boutique : <b>${esc(m.shop_name)}</b></p><div class="panel">${motoForm(m, `/admin/moto/${m.id}/modifier`, 'Enregistrer')}</div></div></section>` });
});
app.post('/admin/moto/:id(\\d+)/modifier', requireAuth, handleUpload, (req, res) => {
  const m = ownMoto(req, res); if (!m) { if (req.file) rmFile(req.file.filename); return; }
  const d = parseMoto(req.body);
  if (!d) { if (req.file) rmFile(req.file.filename); flash(res, 'err', 'Vérifiez le nom, le type et le prix.'); return res.redirect(`/admin/moto/${m.id}/modifier`); }
  const image = req.file ? req.file.filename : m.image;
  db.prepare('UPDATE motos SET title=?,brand=?,type=?,price=?,description=?,image=?,status=? WHERE id=?').run(d.title, d.brand, d.type, d.price, d.description, image, d.status, m.id);
  if (req.file) rmFile(m.image);
  flash(res, 'ok', 'Moto mise à jour.'); res.redirect(req.user.role === 'super' ? '/super' : '/admin');
});
app.post('/admin/moto/:id(\\d+)/supprimer', requireAuth, (req, res) => {
  const m = ownMoto(req, res); if (!m) return;
  db.prepare('DELETE FROM motos WHERE id=?').run(m.id); rmFile(m.image);
  flash(res, 'ok', 'Moto supprimée.'); res.redirect(req.user.role === 'super' ? '/super' : '/admin');
});

app.get('/admin/profil', requireAuth, (req, res) => {
  res.locals.render({ title: 'Mon profil', body: `<section><div class="wrap narrow"><h2>Mon profil</h2><p class="sub">${esc(req.user.email)}</p>
  <form class="stack panel" method="post" action="/admin/profil"><label>Téléphone (appels)<input name="phone" value="${esc(req.user.phone)}" maxlength="30"></label>
  <label>Numéro WhatsApp<input name="whatsapp" value="${esc(req.user.whatsapp)}" maxlength="30"></label>
  <label>Nouveau mot de passe <span class="hint">(laisser vide pour ne pas changer, 8 caractères minimum)</span><input type="password" name="password" minlength="8" autocomplete="new-password"></label>
  <button class="btn" type="submit">Enregistrer</button></form></div></section>` });
});
app.post('/admin/profil', requireAuth, (req, res) => {
  const pw = String(req.body.password || '');
  if (pw && pw.length < 8) { flash(res, 'err', 'Mot de passe trop court (8 caractères minimum).'); return res.redirect('/admin/profil'); }
  db.prepare('UPDATE users SET phone=?, whatsapp=? WHERE id=?').run(String(req.body.phone || '').slice(0, 30), String(req.body.whatsapp || '').slice(0, 30), req.user.id);
  if (pw) {
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(pw, 10), req.user.id);
    // les anciennes sessions (autres appareils) sont invalidées ; celle-ci est renouvelée
    res.cookie('sid', makeToken(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)), { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 8 * 3600e3 });
  }
  flash(res, 'ok', 'Profil mis à jour.'); res.redirect(req.user.role === 'super' ? '/super' : '/admin');
});

// ================= SUPER ADMIN =================
app.get('/super', requireAuth, requireSuper, (req, res) => {
  const shops = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM motos WHERE user_id=u.id) AS nb FROM users u WHERE u.role='admin' ORDER BY u.id DESC`).all();
  const motos = db.prepare('SELECT m.*, u.shop_name, u.active FROM motos m JOIN users u ON u.id=m.user_id ORDER BY m.id DESC').all();
  const inq = db.prepare('SELECT i.*, m.title, u.shop_name FROM inquiries i LEFT JOIN motos m ON m.id=i.moto_id LEFT JOIN users u ON u.id=i.shop_id ORDER BY i.id DESC LIMIT 30').all();
  const total = motos.reduce((s, m) => s + m.price, 0);
  res.locals.render({ title: 'Super administrateur', body: `<section><div class="wrap">
  <div class="dash-head"><h2>Super administrateur</h2><div class="actions"><a class="btn" href="/admin/moto/nouvelle">+ Ajouter une moto</a><a class="btn alt" href="/super/sauvegarde">⬇ Sauvegarde</a><a class="btn alt" href="/admin/profil">Mon profil</a></div></div>
  ${storageIsPersistent() ? '' : '<div class="flash err" role="alert" style="margin:0 0 24px"><b>Stockage temporaire.</b> Le disque permanent n\'est pas encore branché : les boutiques, motos et photos seront effacées à la prochaine mise à jour du site. Ajoutez le disque Render (chemin /var/data).</div>'}
  <div class="kpis"><div class="kpi reveal"><strong data-count="${shops.length}">${shops.length}</strong><span>Boutiques</span></div><div class="kpi reveal"><strong data-count="${motos.length}">${motos.length}</strong><span>Annonces au total</span></div><div class="kpi reveal"><strong data-count="${motos.filter((m) => m.status === 'disponible').length}">${motos.filter((m) => m.status === 'disponible').length}</strong><span>Disponibles</span></div><div class="kpi reveal"><strong data-count="${inq.length}">${inq.length}</strong><span>Demandes récentes</span></div></div>

  <div class="guide reveal"><b>Comment ça marche</b>
    <ol><li><span>Vous créez le compte d'une boutique (ci-dessous) : nom, e-mail et mot de passe du gérant.</span></li>
    <li><span>Le gérant se connecte sur <i>Espace boutique</i> et publie lui-même ses annonces (prix, photo, nom de la boutique).</span></li>
    <li><span>Vous voyez tout ici : boutiques, annonces, demandes des clients. Vous pouvez modifier, suspendre ou supprimer.</span></li></ol></div>

  <h3 class="sec">Boutiques et leurs gérants <span class="hint">(ce sont eux qui publient les annonces)</span></h3>
  <div class="tablewrap"><table><tr><th>Boutique</th><th>E-mail</th><th>Téléphone</th><th>Motos</th><th>Statut</th><th></th></tr>
  ${shops.map((s) => `<tr><td><b>${esc(s.shop_name)}</b></td><td>${esc(s.email)}</td><td>${esc(s.phone || '')}</td><td>${s.nb}</td><td><span class="pill ${s.active ? 'on' : 'off'}">${s.active ? 'Actif' : 'Suspendu'}</span></td>
  <td><div class="actions"><form method="post" action="/super/boutique/${s.id}/${s.active ? 'suspendre' : 'activer'}"><button class="btn alt sm">${s.active ? 'Suspendre' : 'Réactiver'}</button></form>
  <form method="post" action="/super/boutique/${s.id}/mdp" data-prompt-password="Nouveau mot de passe (8 caractères min.) :"><input type="hidden" name="password"><button class="btn alt sm">Mot de passe</button></form>
  <form method="post" action="/super/boutique/${s.id}/supprimer" data-confirm="Supprimer cette boutique et toutes ses motos ?"><button class="btn danger sm">Supprimer</button></form></div></td></tr>`).join('') || '<tr><td colspan="6">Aucune boutique.</td></tr>'}</table></div>

  <h3 class="sec">Créer une boutique et son gérant <span class="hint">(le gérant pourra publier des annonces)</span></h3>
  <form class="stack panel" method="post" action="/super/boutique" style="margin-bottom:28px"><div class="two"><label>Nom de la boutique<input name="shop_name" required maxlength="80" placeholder="Ex. Moto Plus Abidjan"></label><label>E-mail du gérant (pour se connecter)<input type="email" name="email" required></label></div>
  <div class="two"><label>Téléphone<input name="phone" maxlength="30"></label><label>WhatsApp<input name="whatsapp" maxlength="30"></label></div>
  <label>Mot de passe initial <span class="hint">(8 caractères minimum)</span><input name="password" required minlength="8" autocomplete="off"></label><button class="btn" type="submit">Créer la boutique et le gérant</button></form>

  <h3 class="sec">Toutes les motos <span class="hint">(valeur totale du catalogue : ${fcfa(total)})</span></h3>
  <div class="tablewrap"><table><tr><th></th><th>Moto</th><th>Boutique</th><th>Type</th><th>Prix</th><th>Statut</th><th></th></tr>
  ${motos.map((m) => `<tr><td>${m.image ? `<img class="thumb" src="/uploads/${esc(m.image)}" alt="">` : ''}</td><td><a href="/moto/${m.id}"><b>${esc(m.title)}</b></a></td><td>${esc(m.shop_name)}${m.active ? '' : ' <span class="pill off">suspendue</span>'}</td><td>${esc(m.type)}</td><td>${fcfa(m.price)}</td><td>${statusPill(m.status)}</td>
  <td><div class="actions"><a class="btn alt sm" href="/admin/moto/${m.id}/modifier">Modifier</a><form method="post" action="/admin/moto/${m.id}/supprimer" data-confirm="Supprimer cette moto ?"><button class="btn danger sm">Supprimer</button></form></div></td></tr>`).join('') || '<tr><td colspan="7">Aucune moto.</td></tr>'}</table></div>

  <h3 class="sec">Demandes récentes (toutes boutiques)</h3>
  ${inq.length ? `<div class="tablewrap"><table><tr><th>Date</th><th>Nom</th><th>Téléphone</th><th>Boutique</th><th>Moto / sujet</th><th>Message</th></tr>${inq.map((i) => `<tr><td>${esc(i.created_at.slice(0, 16))}</td><td>${esc(i.name)}</td><td><a href="tel:${esc(i.phone)}">${esc(i.phone)}</a></td><td>${esc(i.shop_name || '—')}</td><td>${esc(i.title || i.subject || '—')}</td><td>${esc(i.message || '')}</td></tr>`).join('')}</table></div>` : '<div class="empty">Aucune demande.</div>'}
  </div></section>` });
});

app.get('/super/sauvegarde', requireAuth, requireSuper, (req, res) => {
  try { res.download(backup(), `lobane-sauvegarde-${new Date().toISOString().slice(0, 10)}.db`); }
  catch (e) { console.error('sauvegarde', e); flash(res, 'err', 'Sauvegarde impossible pour le moment.'); res.redirect('/super'); }
});

app.post('/super/boutique', requireAuth, requireSuper, (req, res) => {
  const b = req.body; const email = String(b.email || '').trim().toLowerCase(); const shop = String(b.shop_name || '').trim().slice(0, 80);
  if (!shop || !/^\S+@\S+\.\S+$/.test(email) || String(b.password || '').length < 8) { flash(res, 'err', 'Vérifiez le nom, l\'e-mail et le mot de passe (8 caractères minimum).'); return res.redirect('/super'); }
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) { flash(res, 'err', 'Un compte existe déjà avec cet e-mail.'); return res.redirect('/super'); }
  db.prepare('INSERT INTO users (email,password_hash,role,shop_name,phone,whatsapp) VALUES (?,?,?,?,?,?)').run(email, bcrypt.hashSync(String(b.password), 10), 'admin', shop, String(b.phone || '').slice(0, 30), String(b.whatsapp || b.phone || '').slice(0, 30));
  flash(res, 'ok', `Boutique « ${shop} » créée.`); res.redirect('/super');
});
const shopAction = (fn, msg) => (req, res) => {
  const s = db.prepare("SELECT * FROM users WHERE id=? AND role='admin'").get(req.params.id);
  if (s) { fn(s, req); flash(res, 'ok', msg(s)); } else flash(res, 'err', 'Boutique introuvable.');
  res.redirect('/super');
};
app.post('/super/boutique/:id(\\d+)/suspendre', requireAuth, requireSuper, shopAction((s) => db.prepare('UPDATE users SET active=0 WHERE id=?').run(s.id), (s) => `${s.shop_name} est suspendue (ses motos sont masquées).`));
app.post('/super/boutique/:id(\\d+)/activer', requireAuth, requireSuper, shopAction((s) => db.prepare('UPDATE users SET active=1 WHERE id=?').run(s.id), (s) => `${s.shop_name} est réactivée.`));
app.post('/super/boutique/:id(\\d+)/mdp', requireAuth, requireSuper, (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length < 8) { flash(res, 'err', 'Mot de passe trop court.'); return res.redirect('/super'); }
  return shopAction((s) => db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(pw, 10), s.id), (s) => `Mot de passe de ${s.shop_name} modifié.`)(req, res);
});
app.post('/super/boutique/:id(\\d+)/supprimer', requireAuth, requireSuper, shopAction((s) => {
  db.prepare('SELECT image FROM motos WHERE user_id=?').all(s.id).forEach((m) => rmFile(m.image));
  db.prepare('DELETE FROM users WHERE id=?').run(s.id);
}, (s) => `${s.shop_name} supprimée.`));

// ---- 404 + erreurs ----
app.use((req, res) => res.status(404).send(layout({ title: 'Page introuvable', user: req.user, body: '<section><div class="wrap"><h2>Page introuvable</h2><p class="sub">Cette page n\'existe pas.</p><a class="btn" href="/">Retour à l\'accueil</a></div></section>' })));
app.use((err, req, res, next) => { console.error(err); res.status(500).send(layout({ title: 'Erreur', body: '<section><div class="wrap"><h2>Une erreur est survenue</h2><p class="sub">Réessayez dans un instant.</p></div></section>' })); });

const created = seed();
const PORT = process.env.PORT || 3000;
// sauvegarde quotidienne de la base (au démarrage puis toutes les 24 h)
const runBackup = () => { try { backup(); } catch (e) { console.error('sauvegarde automatique échouée', e.message); } };
setTimeout(runBackup, 15e3).unref(); setInterval(runBackup, 24 * 3600e3).unref();
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
process.on('uncaughtException', (e) => { console.error('uncaughtException', e); process.exit(1); });
const server = app.listen(PORT, () => {
  console.log(`Lobane Motorcycle sur http://localhost:${PORT} (${PROD ? 'production' : 'développement'})`);
  if (PROD && !storageIsPersistent()) console.warn('ATTENTION : stockage non permanent. Branchez un disque Render sur /var/data et définissez DATA_DIR=/var/data.');
  if (created) console.log(created.generated
    ? `Compte super admin créé : ${created.email} / mot de passe généré : ${created.password}  (notez-le puis changez-le dans « Mon profil »)`
    : `Compte super admin créé : ${created.email}` + (PROD ? '' : ` / ${created.password}  (changez ce mot de passe !)`));
});
server.keepAliveTimeout = 65e3; server.headersTimeout = 66e3; // plus longs que le délai du proxy Render
const shutdown = () => { server.close(() => { try { db.close(); } catch (e) {} process.exit(0); }); setTimeout(() => process.exit(0), 8000).unref(); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
