const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const sharp = require('sharp');
const compression = require('compression');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, seed, TYPES, DATA_DIR, backup, storageIsPersistent, syncImages } = require('./db');
const V = require('./views');
const { esc, fcfa, digits, km, etatBadge, shopLine, layout, motoCard, filterForm, motoForm, motoImg, typeIcon } = V;

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
app.use((req, res, next) => { if (req.path === '/sw.js') res.set('Service-Worker-Allowed', '/'); next(); });
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d', setHeaders: (r, f) => { if (/(^|[\\/])sw\.js$|manifest\.webmanifest$|offline\.html$/.test(f)) r.setHeader('Cache-Control', 'no-cache'); else if (/\.(css|js)$/.test(f)) r.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); } })); // css/js : URL versionnée (?v=hash)
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true, setHeaders: (r) => r.setHeader('Content-Disposition', 'inline') }));

// Miniatures (560 px) générées à la demande puis servies depuis le disque : les listes de motos chargent vite.
const THUMB_DIR = path.join(DATA_DIR, 'thumbs'); fs.mkdirSync(THUMB_DIR, { recursive: true });
const thumbBusy = new Map();
app.get('/t/:name', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w.-]{1,80}\.(webp|jpg|jpeg|png)$/i.test(name)) return res.sendStatus(404);
  const out = path.join(THUMB_DIR, name.replace(/\.\w+$/, '') + '.webp'); const src = path.join(UPLOAD_DIR, name);
  const send = () => res.set({ 'Cache-Control': 'public, max-age=2592000, immutable', 'Content-Type': 'image/webp' }).sendFile(out);
  if (fs.existsSync(out)) return send();
  if (!fs.existsSync(src)) return res.redirect(302, `/uploads/${encodeURIComponent(name)}`);
  try {
    if (!thumbBusy.has(out)) thumbBusy.set(out, sharp(src).resize({ width: 560, withoutEnlargement: true }).webp({ quality: 72 }).toFile(out + '.tmp').then(() => fs.renameSync(out + '.tmp', out)).finally(() => thumbBusy.delete(out)));
    await thumbBusy.get(out); send();
  } catch (e) { res.redirect(302, `/uploads/${encodeURIComponent(name)}`); }
});

// Micro-cache des pages publiques (visiteurs sans compte) : 20 s, vidé à chaque changement (annonce, commande, compte…).
const pageCache = new Map(); const PAGE_TTL = 20e3;
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { pageCache.clear(); res.on('finish', () => pageCache.clear()); return next(); }
  if (req.headers.cookie || !/^\/(motos|moto\/\d+)?$/.test(req.path)) return next();
  const key = req.originalUrl; const hit = pageCache.get(key);
  if (hit && hit.exp > Date.now()) { res.set(hit.headers); return res.status(hit.status).send(hit.body); }
  const send = res.send.bind(res);
  res.send = (body) => {
    if (res.statusCode === 200 && typeof body === 'string' && pageCache.size < 300) pageCache.set(key, { exp: Date.now() + PAGE_TTL, status: 200, body, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } });
    return send(body);
  };
  next();
});

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
  const u = tok ? db.prepare('SELECT * FROM users WHERE id=? AND active=1 AND status=\'approved\'').get(tok.uid) : null;
  req.user = u && pwStamp(u.password_hash) === tok.stamp ? u : null;
  const f = req.cookies.flash;
  if (f) { try { res.locals.flash = JSON.parse(Buffer.from(f, 'base64').toString()); } catch {} res.clearCookie('flash'); }
  const nc = req.user ? newCounts(req.user) : null;
  res.locals.badge = nc ? nc.orders + nc.inquiries + nc.pending : 0;
  res.locals.render = (opts) => res.set('Cache-Control', 'no-cache').send(layout({ user: req.user, flash: res.locals.flash, badge: res.locals.badge, ride: !/^\/(admin|super|connexion)/.test(req.path), ...opts }));
  next();
});
const flash = (res, type, msg) => res.cookie('flash', Buffer.from(JSON.stringify({ type, msg })).toString('base64'), { httpOnly: true, sameSite: 'lax', maxAge: 15000 });

const requireAuth = (req, res, next) => (req.user ? next() : res.redirect('/connexion'));
const requireSuper = (req, res, next) => (req.user && req.user.role === 'super' ? next() : res.status(403).send(layout({ title: 'Accès refusé', user: req.user, body: '<section><div class="wrap"><h2>Accès refusé</h2><p class="sub">Cette page est réservée au super administrateur.</p></div></section>' })));

// ---- envoi de fichiers ----
const EXT = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1 };
const MAX_PHOTOS = 5;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: MAX_PHOTOS + 1 },
  fileFilter: (req, file, cb) => cb(null, !!EXT[file.mimetype]),
});
const uploadFields = upload.fields([{ name: 'images', maxCount: MAX_PHOTOS }, { name: 'logo', maxCount: 1 }]);
const rmFile = (name) => { if (name && /^[a-f0-9]+\.(jpg|png|webp)$/.test(name)) fs.rm(path.join(UPLOAD_DIR, name), { force: true }, () => {}); };
// Redimensionne et convertit en WebP (photos légères pour les téléphones). Sharp refuse aussi tout fichier qui n'est pas une vraie image.
async function toWebp(buffer, size = 1400) {
  const name = crypto.randomBytes(12).toString('hex') + '.webp';
  await sharp(buffer, { limitInputPixels: 50e6 }).rotate()
    .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 }).toFile(path.join(UPLOAD_DIR, name));
  return name;
}
// Après cet intergiciel : req.saved = { images: [noms], logo: nom|null } (fichiers déjà enregistrés et optimisés)
const handleUpload = (req, res, next) => uploadFields(req, res, async (err) => {
  const back = req.get('referer') || '/';
  req.saved = { images: [], logo: null };
  if (err) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Photo trop lourde (5 Mo maximum par photo).'
      : (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') ? `Maximum ${MAX_PHOTOS} photos par annonce.` : 'Erreur lors de l\'envoi des photos.';
    flash(res, 'err', msg); return res.redirect(back);
  }
  const f = req.files || {};
  try {
    for (const file of f.images || []) req.saved.images.push(await toWebp(file.buffer));
    if (f.logo && f.logo[0]) req.saved.logo = await toWebp(f.logo[0].buffer, 480);
  } catch (e) {
    discardSaved(req.saved); flash(res, 'err', 'Une des photos n\'est pas une image valide.'); return res.redirect(back);
  }
  next();
});
const discardSaved = (saved) => { [...(saved?.images || []), saved?.logo].forEach(rmFile); };

// galerie d'une moto : photos classées, la première sert de couverture
const photosOf = (motoId) => db.prepare('SELECT id, filename FROM moto_images WHERE moto_id=? ORDER BY position, id').all(motoId);
function writePhotos(motoId, list) { // list = noms de fichiers dans l'ordre voulu
  db.prepare('DELETE FROM moto_images WHERE moto_id=?').run(motoId);
  const ins = db.prepare('INSERT INTO moto_images (moto_id, filename, position) VALUES (?,?,?)');
  list.forEach((n, i) => ins.run(motoId, n, i));
  db.prepare('UPDATE motos SET image=? WHERE id=?').run(list[0] || null, motoId);
}
const removeMotoFiles = (motoId) => photosOf(motoId).forEach((p) => rmFile(p.filename));

// ---- helpers de données ----
const PER_PAGE = 12;
const PUBLIC_MOTOS = `FROM motos m JOIN users u ON u.id=m.user_id WHERE u.active=1`;
const shopsList = () => db.prepare(`SELECT id, shop_name FROM users WHERE active=1 AND status='approved' AND (role='admin' OR EXISTS(SELECT 1 FROM motos WHERE user_id=users.id)) ORDER BY shop_name`).all();

const isOn = (v) => v === '1' || v === 'on' || v === 'true';
function parseMoto(b) {
  const title = String(b.title || '').trim().slice(0, 120);
  const type = TYPES.includes(b.type) ? b.type : null;
  const price = Math.round(Number(b.price));
  const status = b.status === 'vendu' ? 'vendu' : 'disponible';
  if (!title || !type || !Number.isFinite(price) || price < 0 || price > 1e9) return null;
  const thisYear = new Date().getFullYear();
  const y = Math.round(Number(b.year)); const k = Math.round(Number(b.mileage));
  return {
    title, type, price, status,
    brand: String(b.brand || '').trim().slice(0, 60),
    description: String(b.description || '').trim().slice(0, 2000),
    etat: b.etat === 'occasion' ? 'occasion' : 'neuf',
    year: String(b.year || '').trim() !== '' && Number.isFinite(y) && y >= 1980 && y <= thisYear + 1 ? y : null,
    mileage: String(b.mileage || '').trim() !== '' && Number.isFinite(k) && k >= 0 && k <= 1e6 ? k : null,
    color: String(b.color || '').trim().slice(0, 40) || null,
    negotiable: isOn(b.negotiable) ? 1 : 0,
    featured: isOn(b.featured) ? 1 : 0,
  };
}

// ================= SITE PUBLIC =================
app.get('/', (req, res) => {
  const latest = db.prepare(`SELECT m.*, u.shop_name, u.phone, u.whatsapp, u.logo ${PUBLIC_MOTOS} AND m.status='disponible' ORDER BY m.featured DESC, m.id DESC LIMIT 9`).all();
  const nm = db.prepare(`SELECT COUNT(*) c ${PUBLIC_MOTOS}`).get().c;
  const ns = db.prepare(`SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1 AND status='approved'`).get().c;
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
    <div class="cta"><a class="btn" href="#offres">Voir les offres <span class="arr">↓</span></a><a class="btn alt" href="tel:+2250505137178">📞 05 05 13 71 78</a></div>
  </div>
</div>
</div>
<div class="stats"><div class="wrap">
  <div><strong data-count="${nm}">${nm}</strong><span>Motos en ligne</span></div>
  <div><strong data-count="${ns}">${ns}</strong><span>Boutiques partenaires</span></div>
  <div><strong data-count="2016">2016</strong><span>Début de l'aventure</span></div>
  <div><strong data-count="458" data-suffix=" K">458 K</strong><span>Abonnés TikTok</span></div></div></div>
<div class="ribbon" aria-hidden="true"><div class="ribbon-track">${half}${half}</div></div>
<section id="offres" class="alt-bg"><div class="wrap"><h2 class="reveal">Offres disponibles</h2><p class="sub reveal">Les motos publiées par nos boutiques. Choisissez, puis cliquez sur « Commander » pour finir votre achat par WhatsApp.</p>
  ${latest.length ? `<div class="grid g3">${latest.map(motoCard).join('')}</div>` : '<div class="empty">Aucune annonce pour le moment. Les nouvelles motos publiées par les boutiques apparaîtront ici.</div>'}
  <p style="margin-top:28px" class="reveal"><a class="btn" href="/motos">Voir tout le catalogue <span class="arr">→</span></a></p></div></section>
<section><div class="wrap"><h2 class="reveal">Parcourir par type</h2><p class="sub reveal">Choisissez la catégorie qui vous correspond.</p>
  <div class="grid g3">${TYPES.map((t) => `<a class="card type reveal" href="/motos?type=${encodeURIComponent(t)}">${typeIcon(t)}<span><b>${esc(t)}</b><small>${counts[t] || 0} annonce${(counts[t] || 0) > 1 ? 's' : ''}</small></span></a>`).join('')}</div></div></section>
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
  const etat = ['neuf', 'occasion'].includes(req.query.etat) ? req.query.etat : '';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const where = []; const args = [];
  if (etat) { where.push('m.etat=?'); args.push(etat); }
  if (q) { where.push('(m.title LIKE ? OR m.brand LIKE ? OR m.description LIKE ?)'); const l = `%${q.replace(/[%_]/g, '')}%`; args.push(l, l, l); }
  if (type) { where.push('m.type=?'); args.push(type); }
  if (shop) { where.push('m.user_id=?'); args.push(Number(shop)); }
  if (min) { where.push('m.price>=?'); args.push(Number(min)); }
  if (max) { where.push('m.price<=?'); args.push(Number(max)); }
  const cond = where.length ? ' AND ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c ${PUBLIC_MOTOS}${cond}`).get(...args).c;
  const rows = db.prepare(`SELECT m.*, u.shop_name, u.phone, u.whatsapp, u.logo ${PUBLIC_MOTOS}${cond} ORDER BY m.status='vendu', m.featured DESC, m.id DESC LIMIT ? OFFSET ?`).all(...args, PER_PAGE, (page - 1) * PER_PAGE);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const qs = (p) => new URLSearchParams({ q, type, shop, min, max, etat, page: p }).toString();
  res.locals.render({
    title: 'Toutes les motos – Lobane Motorcycle',
    body: `<section><div class="wrap"><h2>Nos motos</h2><p class="sub">${total} annonce${total > 1 ? 's' : ''} trouvée${total > 1 ? 's' : ''}.</p>
    ${filterForm({ q, type, shop, min, max, etat }, shopsList())}
    ${rows.length ? `<div class="grid g3">${rows.map(motoCard).join('')}</div>` : '<div class="empty">Aucune moto ne correspond à votre recherche.</div>'}
    ${pages > 1 ? `<p class="pager">${page > 1 ? `<a class="btn alt sm" href="/motos?${qs(page - 1)}">← Précédent</a>` : ''}<span>Page ${page} / ${pages}</span>${page < pages ? `<a class="btn alt sm" href="/motos?${qs(page + 1)}">Suivant →</a>` : ''}</p>` : ''}
    </div></section>`,
  });
});

const notFoundMoto = (req, res) => res.status(404).send(layout({ title: 'Introuvable', user: req.user, body: '<section><div class="wrap"><h2>Annonce introuvable</h2><p class="sub">Cette moto n\'existe plus ou n\'est plus en ligne.</p><a class="btn" href="/motos">Voir les motos</a></div></section>' }));
const publicMoto = (id) => db.prepare(`SELECT m.*, u.shop_name, u.phone, u.whatsapp, u.logo ${PUBLIC_MOTOS} AND m.id=?`).get(id);

app.get('/moto/:id(\\d+)', (req, res) => {
  const m = publicMoto(req.params.id);
  if (!m) return notFoundMoto(req, res);
  const photos = photosOf(m.id);
  const tel = m.phone || '+2250505137178'; const wa = digits(m.whatsapp || m.phone) || '2250505137178';
  const msg = encodeURIComponent(`Bonjour, je suis intéressé(e) par la moto « ${m.title} » (${fcfa(m.price)}) vue sur le site Lobane Motorcycle.`);
  const spec = (k, v) => (v ? `<li><span>${k}</span><b>${v}</b></li>` : '');
  res.locals.render({
    title: `${m.title} – ${m.shop_name} – Lobane Motorcycle`,
    desc: `${m.title} à ${fcfa(m.price)} chez ${m.shop_name}, Abidjan.`,
    body: `<section><div class="wrap">
    <p class="crumbs"><a href="/">Accueil</a><span>›</span><a href="/motos">Motos</a><span>›</span><a href="/motos?type=${encodeURIComponent(m.type)}">${esc(m.type)}</a></p>
    <div class="detail"><div class="gallery"><div class="imgbox">${motoImg(m, true)}${m.status === 'vendu' ? '<span class="soldtag">Vendu</span>' : ''}<span class="badges">${m.featured ? '<span class="bdg star">★ À la une</span>' : ''}${etatBadge(m)}</span></div>
      ${photos.length > 1 ? `<div class="thumbs">${photos.map((p, i) => `<button type="button" class="thumb-btn${i === 0 ? ' on' : ''}" data-src="/uploads/${esc(p.filename)}" aria-label="Voir la photo ${i + 1}"><img src="/uploads/${esc(p.filename)}" alt="" width="84" height="64" loading="lazy"></button>`).join('')}</div>` : ''}</div>
    <div><span class="tag">${esc(m.type)}</span><h1>${esc(m.title)}</h1><span class="price">${fcfa(m.price)}${m.negotiable ? '<em class="nego">négociable</em>' : ''}</span>
      <ul class="specs">${spec('Boutique', (m.logo ? `<img class="shoplogo" src="/uploads/${esc(m.logo)}" alt="" width="22" height="22"> ` : '') + esc(m.shop_name))}${spec('Marque', esc(m.brand))}${spec('État', m.etat === 'occasion' ? 'Occasion' : 'Neuf')}${spec('Année', m.year ? esc(m.year) : '')}${spec('Kilométrage', m.mileage != null ? km(m.mileage) : '')}${spec('Couleur', esc(m.color))}${spec('Statut', m.status === 'vendu' ? 'Vendu' : 'Disponible')}</ul>
      ${m.description ? `<p>${esc(m.description).replace(/\n/g, '<br>')}</p>` : ''}
      ${m.status === 'vendu' ? '<div class="box"><b>Cette moto est vendue.</b> <a href="/motos">Voir les autres motos</a></div>' : `<div class="box contactbox"><b>Commander cette moto</b>
        <div class="cta"><a class="btn wa" href="/moto/${m.id}/commander">🛒 Commander</a><a class="btn alt" href="tel:${esc(tel)}">📞 Appeler</a><a class="btn alt" href="https://wa.me/${wa}?text=${msg}" target="_blank" rel="noopener">💬 Poser une question</a></div></div>`}
      <form class="stack panel" style="margin-top:18px" method="post" action="/moto/${m.id}/demande"><b>Ou laissez votre numéro, on vous rappelle</b>
        <label>Votre nom<input name="name" required maxlength="80"></label><label>Téléphone<input name="phone" required maxlength="30" inputmode="tel"></label>
        <label>Message (facultatif)<textarea name="message" rows="3" maxlength="1000"></textarea></label><button class="btn red" type="submit">Envoyer</button></form>
    </div></div></div></section>`,
  });
});

// ---- commande : enregistrée dans le back-office, puis confirmation par WhatsApp ----
app.get('/moto/:id(\\d+)/commander', (req, res) => {
  const m = publicMoto(req.params.id);
  if (!m) return notFoundMoto(req, res);
  if (m.status === 'vendu') return res.locals.render({ title: 'Moto vendue', body: `<section><div class="wrap narrow"><h2>Moto déjà vendue</h2><p class="sub">« ${esc(m.title)} » n'est plus disponible.</p><a class="btn" href="/motos">Voir les autres motos</a></div></section>` });
  res.locals.render({
    title: `Commander ${m.title} – Lobane Motorcycle`,
    body: `<section><div class="wrap" style="max-width:720px"><p class="crumbs"><a href="/">Accueil</a><span>›</span><a href="/moto/${m.id}">${esc(m.title)}</a><span>›</span>Commander</p>
    <h2>Commander</h2>
    <div class="ordersum"><div class="thumbbox">${motoImg(m)}</div><div><b>${esc(m.title)}</b><br><span class="price">${fcfa(m.price)}${m.negotiable ? '<em class="nego">négociable</em>' : ''}</span><br><small>${shopLine(m)}</small></div></div>
    <form class="stack panel" method="post" action="/moto/${m.id}/commander">
      <label>Votre nom<input name="name" required maxlength="80" autocomplete="name"></label>
      <label>Téléphone (WhatsApp de préférence)<input name="phone" required maxlength="30" inputmode="tel" autocomplete="tel"></label>
      <label>Quartier / commune de livraison <span class="hint">(facultatif)</span><input name="place" maxlength="120" placeholder="Ex. Koumassi, 3 Ampoules"></label>
      <label>Message <span class="hint">(facultatif)</span><textarea name="message" rows="3" maxlength="600" placeholder="Une précision, un horaire pour vous rappeler…"></textarea></label>
      <button class="btn wa" type="submit">✅ Envoyer ma commande</button>
      <p class="hint">Aucun paiement en ligne. La boutique vous rappelle pour confirmer et convenir de la livraison ou du retrait.</p>
    </form></div></section>`,
  });
});
app.post('/moto/:id(\\d+)/commander', (req, res) => {
  const m = publicMoto(req.params.id);
  if (!m || m.status === 'vendu') return res.redirect(m ? `/moto/${m.id}` : '/motos');
  const back = `/moto/${m.id}/commander`;
  if (limited(`ord:${req.ip}`, 5, 10 * 60e3)) { flash(res, 'err', 'Trop de commandes en peu de temps. Réessayez dans quelques minutes.'); return res.redirect(back); }
  const name = String(req.body.name || '').trim().slice(0, 80); const phone = String(req.body.phone || '').trim().slice(0, 30);
  if (!name || digits(phone).length < 8) { flash(res, 'err', 'Indiquez votre nom et un numéro de téléphone valide.'); return res.redirect(back); }
  const place = String(req.body.place || '').trim().slice(0, 120); const message = String(req.body.message || '').trim().slice(0, 600);
  const r = db.prepare('INSERT INTO orders (shop_id, moto_id, moto_title, price, name, phone, place, message) VALUES (?,?,?,?,?,?,?,?)').run(m.user_id, m.id, m.title, m.price, name, phone, place, message);
  const num = Number(r.lastInsertRowid);
  logAct(m.user_id, 'commande', `Commande n°${num} : ${m.title} (${name})`, m.price);
  const wa = digits(m.whatsapp || m.phone) || '2250505137178';
  const txt = encodeURIComponent(`Bonjour, je viens de passer la commande n°${num} sur le site Lobane Motorcycle : ${m.title} (${fcfa(m.price)}).\nNom : ${name}\nTéléphone : ${phone}${place ? '\nLivraison : ' + place : ''}`);
  res.locals.render({
    title: `Commande n°${num} enregistrée – Lobane Motorcycle`,
    body: `<section><div class="wrap narrow" style="max-width:640px;text-align:center"><div class="okmark" aria-hidden="true">✓</div><h2 style="display:inline-block">Commande enregistrée</h2>
    <p class="sub" style="margin-inline:auto">Merci ${esc(name)} ! Votre commande n°${num} pour <b>${esc(m.title)}</b> (${fcfa(m.price)}) a été transmise à <b>${esc(m.shop_name)}</b>. La boutique vous rappelle très vite.</p>
    <p>Pour aller plus vite, prévenez la boutique sur WhatsApp :</p>
    <div class="cta" style="justify-content:center;margin-top:14px"><a class="btn wa" href="https://wa.me/${wa}?text=${txt}" target="_blank" rel="noopener">💬 Envoyer sur WhatsApp</a><a class="btn alt" href="/motos">Voir d'autres motos</a></div></div></section>`,
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

// ================= INSCRIPTION (ouverte à tous, validée par le super administrateur) =================
app.get('/inscription', (req, res) => {
  if (req.user) return res.redirect(homeOf(req.user));
  res.locals.render({ title: 'Créer un compte – Lobane Motorcycle', body: `<section><div class="wrap narrow" style="max-width:640px"><h2 class="reveal">Créer un compte</h2>
  <p class="sub reveal">Vous vendez des motos ? Créez le compte de votre boutique. <b>Le super administrateur doit le valider</b> avant que vous puissiez publier des annonces.</p>
  <form class="stack panel reveal" method="post" action="/inscription">
    <label>Nom de la boutique<input name="shop_name" required maxlength="80" placeholder="Ex. Moto Plus Abidjan" autocomplete="organization"></label>
    <label>E-mail (pour vous connecter)<input type="email" name="email" required autocomplete="username"></label>
    <div class="two"><label>Téléphone<input name="phone" required maxlength="30" inputmode="tel" autocomplete="tel"></label><label>WhatsApp <span class="hint">(les commandes arrivent ici)</span><input name="whatsapp" maxlength="30" inputmode="tel"></label></div>
    <label>Mot de passe <span class="hint">(8 caractères minimum)</span><input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
    <div class="hp" aria-hidden="true"><label>Ne pas remplir<input name="website" tabindex="-1" autocomplete="off"></label></div>
    <button class="btn red" type="submit">Envoyer ma demande</button>
    <p class="hint">Déjà un compte ? <a href="/connexion"><b>Se connecter</b></a></p>
  </form></div></section>` });
});
app.post('/inscription', async (req, res) => {
  if (req.user) return res.redirect(homeOf(req.user));
  const b = req.body;
  if (String(b.website || '') !== '') return res.redirect('/inscription'); // champ piège : un robot l'a rempli
  if (limited(`signup:${req.ip}`, 3, 3600e3)) { flash(res, 'err', 'Trop de demandes. Réessayez plus tard.'); return res.redirect('/inscription'); }
  const email = String(b.email || '').trim().toLowerCase(); const shop = String(b.shop_name || '').trim().slice(0, 80);
  const phone = String(b.phone || '').trim().slice(0, 30); const pw = String(b.password || '');
  if (!shop || !EMAIL_RE.test(email) || email.length > 120 || digits(phone).length < 8 || pw.length < 8 || pw.length > 200) {
    flash(res, 'err', 'Vérifiez le nom, l\'e-mail, le téléphone et le mot de passe (8 caractères minimum).'); return res.redirect('/inscription');
  }
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) { flash(res, 'err', 'Un compte existe déjà avec cet e-mail. Connectez-vous ou utilisez un autre e-mail.'); return res.redirect('/inscription'); }
  if (db.prepare("SELECT COUNT(*) c FROM users WHERE status='pending'").get().c >= 100) { flash(res, 'err', 'Trop de demandes en attente pour le moment. Réessayez plus tard.'); return res.redirect('/inscription'); }
  db.prepare("INSERT INTO users (email,password_hash,role,shop_name,phone,whatsapp,status) VALUES (?,?,'admin',?,?,?,'pending')")
    .run(email, await bcrypt.hash(pw, 10), shop, phone, String(b.whatsapp || phone).trim().slice(0, 30));
  res.locals.render({ title: 'Demande envoyée – Lobane Motorcycle', body: `<section><div class="wrap narrow" style="max-width:640px;text-align:center"><div class="okmark" aria-hidden="true">✓</div><h2 style="display:inline-block">Demande envoyée</h2>
  <p class="sub" style="margin-inline:auto">Merci ! Le compte de <b>${esc(shop)}</b> est en attente de validation par le super administrateur de Lobane Motorcycle. Dès qu'il est validé, connectez-vous avec <b>${esc(email)}</b> pour publier vos annonces.</p>
  <div class="cta" style="justify-content:center;margin-top:14px"><a class="btn" href="/">Retour à l'accueil</a><a class="btn alt" href="/connexion">Se connecter</a></div></div></section>` });
});

// ================= AUTHENTIFICATION =================
app.get('/connexion', (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'super' ? '/super' : '/admin');
  res.locals.render({ title: 'Connexion – Espace boutique', body: `<section><div class="wrap narrow"><h2 class="reveal">Espace boutique</h2><p class="sub reveal">Gérants de boutique : connectez-vous pour publier et gérer vos annonces de motos.</p>
  <form class="stack panel" method="post" action="/connexion"><label>E-mail<input type="email" name="email" required autocomplete="username"></label>
  <label>Mot de passe<input type="password" name="password" required autocomplete="current-password"></label><button class="btn" type="submit">Se connecter</button></form></div></section>` });
});
app.post('/connexion', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (limited(`login:${req.ip}`, 10, 15 * 60e3) || limited(`loginu:${email}`, 8, 15 * 60e3)) { flash(res, 'err', 'Trop de tentatives. Réessayez dans 15 minutes.'); return res.redirect('/connexion'); }
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  const ok = (await bcrypt.compare(String(req.body.password || ''), u ? u.password_hash : DUMMY_HASH)) && !!u;
  if (!ok) { flash(res, 'err', 'E-mail ou mot de passe incorrect.'); return res.redirect('/connexion'); }
  if (u.status === 'pending') { flash(res, 'err', 'Votre compte est en attente de validation par le super administrateur. Vous pourrez vous connecter dès qu\'il sera validé.'); return res.redirect('/connexion'); }
  if (!u.active) { flash(res, 'err', 'Ce compte est suspendu. Contactez Lobane Motorcycle.'); return res.redirect('/connexion'); }
  res.cookie('sid', makeToken(u), { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 8 * 3600e3 });
  res.redirect(u.role === 'super' ? '/super' : '/admin');
});
app.post('/deconnexion', (req, res) => { res.clearCookie('sid'); res.redirect('/'); });

// ================= ESPACE BOUTIQUE =================
const statusPill = (s) => `<span class="pill ${s === 'vendu' ? 'sold' : 'on'}">${s === 'vendu' ? 'Vendu' : 'Disponible'}</span>`;
const ORDER_STATUS = { nouvelle: 'Nouvelle', confirmee: 'Confirmée', livree: 'Livrée', annulee: 'Annulée' };
const orderPill = (s) => `<span class="pill ${s === 'nouvelle' ? 'new' : s === 'annulee' ? 'off' : 'on'}">${ORDER_STATUS[s] || esc(s)}</span>`;
const likeq = (q) => `%${q.replace(/[%_\\]/g, '')}%`;
const searchQ = (req) => String(req.query.q || '').trim().slice(0, 60);
const homeOf = (u) => (u.role === 'super' ? '/super' : '/admin');

// nouveautés à traiter (commandes nouvelles + demandes non traitées) : pastille du menu et indicateurs
function newCounts(user) {
  const sh = user.role === 'super' ? '' : ' AND shop_id=?'; const a = user.role === 'super' ? [] : [user.id];
  return {
    orders: db.prepare(`SELECT COUNT(*) c FROM orders WHERE status='nouvelle'${sh}`).get(...a).c,
    inquiries: db.prepare(`SELECT COUNT(*) c FROM inquiries WHERE handled=0${sh}`).get(...a).c,
    pending: user.role === 'super' ? db.prepare("SELECT COUNT(*) c FROM users WHERE status='pending'").get().c : 0,
  };
}
function loadOrders(user, q) {
  const where = []; const args = [];
  if (user.role !== 'super') { where.push('o.shop_id=?'); args.push(user.id); }
  if (q) { where.push('(o.name LIKE ? OR o.phone LIKE ? OR o.moto_title LIKE ? OR o.place LIKE ?)'); const l = likeq(q); args.push(l, l, l, l); }
  return db.prepare(`SELECT o.*, u.shop_name FROM orders o LEFT JOIN users u ON u.id=o.shop_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY (o.status='nouvelle') DESC, o.id DESC LIMIT 60`).all(...args);
}
function loadInquiries(user, q) {
  const where = []; const args = [];
  if (user.role !== 'super') { where.push('i.shop_id=?'); args.push(user.id); }
  if (q) { where.push('(i.name LIKE ? OR i.phone LIKE ? OR i.message LIKE ? OR i.subject LIKE ? OR m.title LIKE ?)'); const l = likeq(q); args.push(l, l, l, l, l); }
  return db.prepare(`SELECT i.*, m.title, u.shop_name FROM inquiries i LEFT JOIN motos m ON m.id=i.moto_id LEFT JOIN users u ON u.id=i.shop_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.handled, i.id DESC LIMIT 60`).all(...args);
}
const searchBar = (action, q) => `<form class="searchbar" method="get" action="${action}"><input type="search" name="q" value="${esc(q)}" placeholder="Rechercher un client, un numéro, une moto…" maxlength="60" aria-label="Rechercher"><button class="btn alt sm" type="submit">Rechercher</button>${q ? `<a class="btn sm" href="${action}">Effacer</a>` : ''}</form>`;

function ordersTable(rows, showShop) {
  if (!rows.length) return '<div class="empty" style="margin-bottom:28px">Aucune commande pour le moment. Dès qu\'un client commande, elle apparaît ici.</div>';
  return `<div class="tablewrap"><table><tr><th>Date</th><th>Client</th><th>Moto</th>${showShop ? '<th>Boutique</th>' : ''}<th>Livraison</th><th>Statut</th><th>Changer</th></tr>${rows.map((o) => `<tr class="${o.status === 'nouvelle' ? 'rownew' : ''}"><td>${esc(o.created_at.slice(0, 16))}</td><td><b>${esc(o.name)}</b><br><a href="tel:${esc(o.phone)}">${esc(o.phone)}</a></td>
  <td>${o.moto_id ? `<a href="/moto/${o.moto_id}">${esc(o.moto_title)}</a>` : esc(o.moto_title)}<br><small>${fcfa(o.price)}</small></td>${showShop ? `<td>${esc(o.shop_name || '—')}</td>` : ''}<td>${esc(o.place || '—')}${o.message ? `<br><small>${esc(o.message)}</small>` : ''}</td><td>${orderPill(o.status)}</td>
  <td><form method="post" action="/admin/commande/${o.id}/statut" class="inl"><select name="status" data-autosubmit aria-label="Changer le statut">${Object.entries(ORDER_STATUS).map(([k, l]) => `<option value="${k}" ${k === o.status ? 'selected' : ''}>${l}</option>`).join('')}</select><noscript><button class="btn alt sm">OK</button></noscript></form></td></tr>`).join('')}</table></div>`;
}
function inquiriesTable(rows, showShop) {
  if (!rows.length) return '<div class="empty" style="margin-bottom:28px">Aucune demande pour le moment.</div>';
  return `<div class="tablewrap"><table><tr><th>Date</th><th>Nom</th><th>Téléphone</th>${showShop ? '<th>Boutique</th>' : ''}<th>Moto / sujet</th><th>Message</th><th>Suivi</th></tr>${rows.map((i) => `<tr class="${i.handled ? '' : 'rownew'}"><td>${esc(i.created_at.slice(0, 16))}</td><td>${esc(i.name)}</td><td><a href="tel:${esc(i.phone)}">${esc(i.phone)}</a></td>${showShop ? `<td>${esc(i.shop_name || '—')}</td>` : ''}<td>${esc(i.title || i.subject || '—')}</td><td>${esc(i.message || '')}</td>
  <td><form method="post" action="/admin/demande/${i.id}/traitee" class="inl"><button class="btn ${i.handled ? 'alt' : ''} sm">${i.handled ? '✓ Traitée · rouvrir' : 'Marquer traitée'}</button></form></td></tr>`).join('')}</table></div>`;
}
const motoRows = (motos, { showShop = false } = {}) => motos.map((m) => `<tr><td>${m.image ? `<img class="thumb" src="/uploads/${esc(m.image)}" alt="">` : ''}</td><td><a href="/moto/${m.id}"><b>${esc(m.title)}</b></a>${m.featured ? ' <span class="pill new">★ à la une</span>' : ''}</td>${showShop ? `<td>${esc(m.shop_name)}${m.active ? '' : ' <span class="pill off">suspendue</span>'}</td>` : ''}<td>${esc(m.type)}<br><small>${m.etat === 'occasion' ? 'Occasion' : 'Neuf'}${m.year ? ' · ' + esc(m.year) : ''}</small></td><td>${fcfa(m.price)}</td><td>${statusPill(m.status)}</td>
  <td><div class="actions"><a class="btn alt sm" href="/admin/moto/${m.id}/modifier">Modifier</a><form method="post" action="/admin/moto/${m.id}/supprimer" data-confirm="Supprimer cette moto ?"><button class="btn danger sm">Supprimer</button></form></div></td></tr>`).join('');


// ================= SUIVI DES BOUTIQUES (mouvements, stock, ventes) =================
const ACT = { publication: ['🆕', 'Publication'], modification: ['✏️', 'Modification'], vente: ['💰', 'Vente'], retour: ['↩️', 'Remise en vente'], suppression: ['🗑️', 'Suppression'], commande: ['🛒', 'Commande reçue'], statut: ['📦', 'Commande'] };
function logAct(shopId, kind, label, amount = null) {
  try { db.prepare('INSERT INTO activity (shop_id,kind,label,amount) VALUES (?,?,?,?)').run(shopId, kind, String(label).slice(0, 200), amount); } catch (e) { console.error('activity', e.message); }
}
// Chiffres d'une boutique (ou de toutes si shopId vaut null)
function shopStats(shopId) {
  const w = shopId ? 'WHERE user_id=?' : ''; const a = shopId ? [shopId] : [];
  const m = db.prepare(`SELECT COUNT(*) total, SUM(status='disponible') stock, COALESCE(SUM(CASE WHEN status='disponible' THEN price END),0) stockValue, SUM(status='vendu') sold, COALESCE(SUM(CASE WHEN status='vendu' THEN price END),0) revenue FROM motos ${w}`).get(...a);
  const wo = shopId ? 'WHERE shop_id=?' : '';
  const o = db.prepare(`SELECT COUNT(*) total, SUM(status='nouvelle') news, SUM(status='confirmee') confirmed, SUM(status='livree') delivered, SUM(status='annulee') cancelled, COALESCE(SUM(CASE WHEN status='livree' THEN price END),0) delivered_amount FROM orders ${wo}`).get(...a);
  const last = db.prepare(`SELECT MAX(created_at) t FROM activity ${shopId ? 'WHERE shop_id=?' : ''}`).get(...a).t;
  return { total: m.total || 0, stock: m.stock || 0, stockValue: m.stockValue, sold: m.sold || 0, revenue: m.revenue,
    orders: o.total || 0, news: o.news || 0, confirmed: o.confirmed || 0, delivered: o.delivered || 0, cancelled: o.cancelled || 0, last };
}
// Bannière animée des espaces d'administration : une moto qui roule sur la route
const MOTO_IMG = '<img class="bk" src="/img/demo/winner-cutout.webp" width="886" height="774" alt="" decoding="async">';
const dashBanner = ({ tag, title, sub = '', actions = '' }) => `<div class="dashhero reveal">
  <div class="dashhero-text"><span class="tag">${tag}</span><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}<div class="actions">${actions}</div></div>
  <div class="dashhero-road" aria-hidden="true"><span class="speed s1"></span><span class="speed s2"></span><span class="speed s3"></span><div class="rider">${MOTO_IMG}</div><div class="lane"></div></div></div>`;
const kpiX = (n, l, o = {}) => `<div class="kpi reveal${o.tone ? ' ' + o.tone : ''}"><strong data-count="${n}"${o.suffix ? ` data-suffix="${o.suffix}"` : ''}>${n}</strong><span>${l}</span></div>`;
const kpiMoney = (n, l, tone = '') => `<div class="kpi money reveal ${tone}"><strong>${fcfa(n)}</strong><span>${l}</span></div>`;

app.get('/admin', requireAuth, (req, res) => {
  if (req.user.role === 'super') return res.redirect('/super');
  const q = searchQ(req); const c = newCounts(req.user);
  const motos = db.prepare('SELECT * FROM motos WHERE user_id=? ORDER BY id DESC').all(req.user.id);
  const st = shopStats(req.user.id);
  res.locals.render({ title: 'Mon espace boutique', body: `<section><div class="wrap">
  ${dashBanner({ tag: 'Espace gérant', title: esc(req.user.shop_name), sub: 'C\'est vous qui publiez les annonces de votre boutique et qui suivez les commandes des clients.', actions: '<a class="btn" href="/admin/moto/nouvelle">+ Publier une annonce</a><a class="btn alt" href="/admin/profil">Mon profil</a>' })}
  <div class="kpis">${kpiX(c.orders, 'Commandes à traiter')}${kpiX(c.inquiries, 'Demandes à rappeler')}${kpiX(st.stock, 'Motos en stock')}${kpiX(st.sold, 'Motos vendues')}</div>
  <div class="kpis kpis3">${kpiMoney(st.stockValue, 'Valeur du stock')}${kpiMoney(st.revenue, 'Ventes réalisées', 'gold')}${kpiX(st.delivered, 'Commandes livrées')}</div>
  ${searchBar('/admin', q)}
  <h3 class="sec">Commandes</h3>${ordersTable(loadOrders(req.user, q), false)}
  <h3 class="sec">Mes annonces</h3>
  ${motos.length ? `<div class="tablewrap"><table><tr><th></th><th>Moto</th><th>Type</th><th>Prix</th><th>Statut</th><th></th></tr>${motoRows(motos)}</table></div>` : '<div class="empty" style="margin-bottom:28px">Vous n\'avez pas encore publié de moto. Cliquez sur « Publier une annonce ».</div>'}
  <h3 class="sec">Demandes de rappel</h3>${inquiriesTable(loadInquiries(req.user, q), false)}
  </div></section>` });
});

function setStatus(req, res, kind) {
  const row = db.prepare(`SELECT * FROM ${kind} WHERE id=?`).get(req.params.id);
  if (!row || (req.user.role !== 'super' && row.shop_id !== req.user.id)) { flash(res, 'err', 'Introuvable.'); return null; }
  return row;
}
app.post('/admin/commande/:id(\\d+)/statut', requireAuth, (req, res) => {
  const o = setStatus(req, res, 'orders');
  const st = String(req.body.status || '');
  if (o && ORDER_STATUS[st]) {
    db.prepare("UPDATE orders SET status=?, updated_at=datetime('now') WHERE id=?").run(st, o.id);
    if (o.status !== st) {
      logAct(o.shop_id, 'statut', `Commande n°${o.id} « ${o.moto_title} » : ${ORDER_STATUS[st].toLowerCase()}`, st === 'livree' ? o.price : null);
      const mm = o.moto_id && db.prepare('SELECT * FROM motos WHERE id=?').get(o.moto_id);
      if (st === 'livree' && mm && mm.status !== 'vendu') { db.prepare("UPDATE motos SET status='vendu' WHERE id=?").run(mm.id); logAct(o.shop_id, 'vente', `Vendue (commande livrée) : ${mm.title}`, mm.price); }
    }
    flash(res, 'ok', `Commande n°${o.id} : ${ORDER_STATUS[st].toLowerCase()}.`); }
  else if (o) flash(res, 'err', 'Statut invalide.');
  res.redirect(homeOf(req.user));
});
app.post('/admin/demande/:id(\\d+)/traitee', requireAuth, (req, res) => {
  const i = setStatus(req, res, 'inquiries');
  if (i) { db.prepare('UPDATE inquiries SET handled=? WHERE id=?').run(i.handled ? 0 : 1, i.id); flash(res, 'ok', i.handled ? 'Demande rouverte.' : 'Demande marquée comme traitée.'); }
  res.redirect(homeOf(req.user));
});

// ---- annonces (photos multiples) ----
app.get('/admin/moto/nouvelle', requireAuth, (req, res) => {
  res.locals.render({ title: 'Publier une annonce', body: `<section><div class="wrap narrow" style="max-width:680px"><h2>Publier une annonce</h2><p class="sub">Boutique : <b>${esc(req.user.shop_name)}</b>. L'annonce apparaît tout de suite sur la page d'accueil.</p><div class="panel">${motoForm({}, '/admin/moto/nouvelle', 'Publier la moto', { canFeature: req.user.role === 'super' })}</div></div></section>` });
});
app.post('/admin/moto/nouvelle', requireAuth, handleUpload, (req, res) => {
  const d = parseMoto(req.body);
  if (!d) { discardSaved(req.saved); flash(res, 'err', 'Vérifiez le nom, le type et le prix.'); return res.redirect('/admin/moto/nouvelle'); }
  const r = db.prepare('INSERT INTO motos (user_id,title,brand,type,price,description,status,year,mileage,color,etat,negotiable,featured) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(req.user.id, d.title, d.brand, d.type, d.price, d.description, d.status, d.year, d.mileage, d.color, d.etat, d.negotiable, req.user.role === 'super' ? d.featured : 0);
  writePhotos(Number(r.lastInsertRowid), req.saved.images);
  logAct(req.user.id, 'publication', `Annonce publiée : ${d.title}`, d.price);
  if (d.status === 'vendu') logAct(req.user.id, 'vente', `Vendue : ${d.title}`, d.price);
  flash(res, 'ok', 'Annonce publiée : elle est visible sur la page d\'accueil.'); res.redirect(homeOf(req.user));
});

function ownMoto(req, res) {
  const m = db.prepare('SELECT m.*, u.shop_name FROM motos m JOIN users u ON u.id=m.user_id WHERE m.id=?').get(req.params.id);
  if (!m || (req.user.role !== 'super' && m.user_id !== req.user.id)) { res.status(404).send(layout({ title: 'Introuvable', user: req.user, body: '<section><div class="wrap"><h2>Moto introuvable</h2></div></section>' })); return null; }
  return m;
}
app.get('/admin/moto/:id(\\d+)/modifier', requireAuth, (req, res) => {
  const m = ownMoto(req, res); if (!m) return;
  res.locals.render({ title: 'Modifier la moto', body: `<section><div class="wrap narrow" style="max-width:680px"><h2>Modifier la moto</h2><p class="sub">Boutique : <b>${esc(m.shop_name)}</b></p><div class="panel">${motoForm(m, `/admin/moto/${m.id}/modifier`, 'Enregistrer', { photos: photosOf(m.id), canFeature: req.user.role === 'super' })}</div></div></section>` });
});
app.post('/admin/moto/:id(\\d+)/modifier', requireAuth, handleUpload, (req, res) => {
  const m = ownMoto(req, res); if (!m) { discardSaved(req.saved); return; }
  const d = parseMoto(req.body);
  const back = `/admin/moto/${m.id}/modifier`;
  if (!d) { discardSaved(req.saved); flash(res, 'err', 'Vérifiez le nom, le type et le prix.'); return res.redirect(back); }
  const cur = photosOf(m.id);
  const remove = new Set([].concat(req.body.remove_img || []).map(String));
  let keep = cur.filter((p) => !remove.has(String(p.id)));
  if (keep.length + req.saved.images.length > MAX_PHOTOS) { discardSaved(req.saved); flash(res, 'err', `Maximum ${MAX_PHOTOS} photos par annonce : supprimez-en avant d'en ajouter.`); return res.redirect(back); }
  const cover = keep.find((p) => String(p.id) === String(req.body.cover));
  if (cover) keep = [cover, ...keep.filter((p) => p !== cover)];
  cur.filter((p) => remove.has(String(p.id))).forEach((p) => rmFile(p.filename));
  writePhotos(m.id, [...keep.map((p) => p.filename), ...req.saved.images]);
  db.prepare('UPDATE motos SET title=?,brand=?,type=?,price=?,description=?,status=?,year=?,mileage=?,color=?,etat=?,negotiable=?,featured=? WHERE id=?')
    .run(d.title, d.brand, d.type, d.price, d.description, d.status, d.year, d.mileage, d.color, d.etat, d.negotiable, req.user.role === 'super' ? d.featured : m.featured, m.id);
  if (m.status !== d.status) logAct(m.user_id, d.status === 'vendu' ? 'vente' : 'retour', `${d.status === 'vendu' ? 'Vendue' : 'Remise en vente'} : ${d.title}`, d.price);
  else logAct(m.user_id, 'modification', `Annonce modifiée : ${d.title}`, d.price);
  flash(res, 'ok', 'Annonce mise à jour.'); res.redirect(homeOf(req.user));
});
app.post('/admin/moto/:id(\\d+)/supprimer', requireAuth, (req, res) => {
  const m = ownMoto(req, res); if (!m) return;
  removeMotoFiles(m.id); db.prepare('DELETE FROM motos WHERE id=?').run(m.id);
  logAct(m.user_id, 'suppression', `Annonce supprimée : ${m.title}`, m.price);
  flash(res, 'ok', 'Annonce supprimée.'); res.redirect(homeOf(req.user));
});

// ---- profil (téléphone, WhatsApp, logo, mot de passe) ----
app.get('/admin/profil', requireAuth, (req, res) => {
  res.locals.render({ title: 'Mon profil', body: `<section><div class="wrap narrow"><h2>Mon profil</h2><p class="sub">${esc(req.user.email)}</p>
  <form class="stack panel" method="post" action="/admin/profil" enctype="multipart/form-data"><label>Téléphone (appels)<input name="phone" value="${esc(req.user.phone)}" maxlength="30"></label>
  <label>Numéro WhatsApp <span class="hint">(les commandes arrivent ici)</span><input name="whatsapp" value="${esc(req.user.whatsapp)}" maxlength="30"></label>
  <label>Logo de la boutique <span class="hint">(facultatif)</span>${req.user.logo ? `<span class="logoprev"><img src="/uploads/${esc(req.user.logo)}" alt="" width="56" height="56"><span class="chk"><input type="checkbox" name="remove_logo" value="1"> Retirer le logo</span></span>` : ''}<input type="file" name="logo" accept="image/jpeg,image/png,image/webp"></label>
  <label>Nouveau mot de passe <span class="hint">(laisser vide pour ne pas changer, 8 caractères minimum)</span><input type="password" name="password" minlength="8" autocomplete="new-password"></label>
  <button class="btn" type="submit">Enregistrer</button></form></div></section>` });
});
app.post('/admin/profil', requireAuth, handleUpload, (req, res) => {
  const pw = String(req.body.password || '');
  if (pw && pw.length < 8) { discardSaved(req.saved); flash(res, 'err', 'Mot de passe trop court (8 caractères minimum).'); return res.redirect('/admin/profil'); }
  db.prepare('UPDATE users SET phone=?, whatsapp=? WHERE id=?').run(String(req.body.phone || '').slice(0, 30), String(req.body.whatsapp || '').slice(0, 30), req.user.id);
  if (req.saved.logo || isOn(req.body.remove_logo)) { rmFile(req.user.logo); db.prepare('UPDATE users SET logo=? WHERE id=?').run(req.saved.logo || null, req.user.id); }
  if (pw) {
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(pw, 10), req.user.id);
    // les anciennes sessions (autres appareils) sont invalidées ; celle-ci est renouvelée
    res.cookie('sid', makeToken(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)), { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 8 * 3600e3 });
  }
  flash(res, 'ok', 'Profil mis à jour.'); res.redirect(homeOf(req.user));
});

// ================= SUPER ADMIN =================
const EMAIL_RE = /^\S+@\S+\.\S+$/;
app.get('/super', requireAuth, requireSuper, (req, res) => {
  const q = searchQ(req); const c = newCounts(req.user);
  const users = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM motos WHERE user_id=u.id) AS nb, (SELECT COUNT(*) FROM orders WHERE shop_id=u.id AND status='nouvelle') AS newo FROM users u ORDER BY u.id DESC`).all();
  const pending = users.filter((u) => u.status === 'pending');
  const shops = users.filter((u) => u.role === 'admin' && u.status !== 'pending'); const admins = users.filter((u) => u.role === 'super');
  const motos = db.prepare('SELECT m.*, u.shop_name, u.active FROM motos m JOIN users u ON u.id=m.user_id ORDER BY m.id DESC LIMIT 300').all();
  const total = motos.reduce((s, m) => s + m.price, 0);
  const all = shopStats(null);
  const perShop = shops.map((u) => ({ u, st: shopStats(u.id) })); const maxRev = Math.max(1, ...perShop.map((x) => x.st.revenue));
  const acctRows = (list) => list.map((s) => {
    const self = s.id === req.user.id;
    return `<tr><td>${s.logo ? `<img class="shoplogo" src="/uploads/${esc(s.logo)}" alt="" width="22" height="22"> ` : ''}<b>${esc(s.shop_name)}</b>${self ? ' <span class="pill on">vous</span>' : ''}</td><td>${esc(s.email)}</td><td>${esc(s.phone || '')}</td><td>${s.nb}${s.newo ? ` <span class="pill new">${s.newo} cmd</span>` : ''}</td><td><span class="pill ${s.active ? 'on' : 'off'}">${s.active ? 'Actif' : 'Suspendu'}</span></td>
    <td><div class="actions">${self ? '<a class="btn alt sm" href="/admin/profil">Mon profil</a>' : `<a class="btn alt sm" href="/super/boutique/${s.id}/modifier">Modifier</a>
    <form method="post" action="/super/boutique/${s.id}/${s.active ? 'suspendre' : 'activer'}"><button class="btn alt sm">${s.active ? 'Suspendre' : 'Réactiver'}</button></form>
    <form method="post" action="/super/boutique/${s.id}/mdp" data-prompt-password="Nouveau mot de passe (8 caractères min.) :"><input type="hidden" name="password"><button class="btn alt sm">Mot de passe</button></form>
    <form method="post" action="/super/boutique/${s.id}/supprimer" data-confirm="Supprimer ce compte${s.role === 'admin' ? ', toutes ses annonces et ses commandes' : ''} ? Cette action est définitive."><button class="btn danger sm">Supprimer</button></form>`}</div></td></tr>`;
  }).join('');
  res.locals.render({ title: 'Super administrateur', body: `<section><div class="wrap">
  ${dashBanner({ tag: 'Supervision', title: 'Super administrateur', sub: 'Vous voyez tout : chaque boutique, ses stocks, ses ventes et ses mouvements.', actions: '<a class="btn red" href="/super/compte/nouveau">+ Ajouter un compte</a><a class="btn" href="/admin/moto/nouvelle">+ Ajouter une moto</a><a class="btn alt" href="/super/sauvegarde">⬇ Sauvegarde</a><a class="btn alt" href="/admin/profil">Mon profil</a>' })}
  ${storageIsPersistent() ? '' : '<div class="flash err" role="alert" style="margin:0 0 24px"><b>Stockage temporaire.</b> Le disque permanent n\'est pas encore branché : les boutiques, motos et photos seront effacées à la prochaine mise à jour du site. Ajoutez le disque Render (chemin /var/data).</div>'}
  <div class="kpis">${kpiX(c.pending, 'Comptes à valider')}${kpiX(shops.length, 'Boutiques')}${kpiX(c.orders, 'Commandes à traiter')}${kpiX(c.inquiries, 'Demandes à rappeler')}</div>
  <div class="kpis">${kpiX(all.stock, 'Motos en stock')}${kpiMoney(all.stockValue, 'Valeur du stock', '')}${kpiX(all.sold, 'Motos vendues')}${kpiMoney(all.revenue, 'Ventes réalisées', 'gold')}</div>
  ${pending.length ? `<h3 class="sec">Comptes à valider <span class="pill new">${pending.length}</span></h3>
  <div class="tablewrap"><table><tr><th>Date</th><th>Boutique</th><th>E-mail</th><th>Téléphone</th><th></th></tr>${pending.map((p) => `<tr class="rownew"><td>${esc(p.created_at.slice(0, 16))}</td><td><b>${esc(p.shop_name)}</b></td><td>${esc(p.email)}</td><td><a href="tel:${esc(p.phone)}">${esc(p.phone)}</a></td>
  <td><div class="actions"><form method="post" action="/super/boutique/${p.id}/valider"><button class="btn sm">✓ Valider</button></form><form method="post" action="/super/boutique/${p.id}/refuser" data-confirm="Refuser et supprimer cette demande ?"><button class="btn danger sm">Refuser</button></form></div></td></tr>`).join('')}</table></div>` : ''}
  <div class="guide reveal"><b>Comment ça marche</b>
    <ol><li><span>Vous créez le compte d'une boutique (ci-dessous) : nom, e-mail et mot de passe du gérant.</span></li>
    <li><span>Le gérant se connecte sur <i>Espace boutique</i>, publie ses annonces (jusqu'à 5 photos) et suit les commandes de ses clients.</span></li>
    <li><span>Vous voyez tout ici : boutiques, annonces, commandes, demandes. Vous pouvez modifier, suspendre ou supprimer, et mettre une moto « À la une ».</span></li></ol></div>
  <h3 class="sec">Suivi des boutiques <span class="hint">(stock, ventes et mouvements de chacune)</span></h3>
  <div class="tablewrap"><table><tr><th>Boutique</th><th>En stock</th><th>Vendues</th><th>Ventes (FCFA)</th><th>Commandes</th><th>Dernier mouvement</th><th></th></tr>${perShop.map(({ u, st }) => `<tr><td><b>${esc(u.shop_name)}</b>${u.active ? '' : ' <span class="pill off">suspendue</span>'}</td><td>${st.stock} <small>(${fcfa(st.stockValue)})</small></td><td>${st.sold}</td><td><b>${fcfa(st.revenue)}</b><span class="bar"><i style="width:${Math.round((st.revenue / maxRev) * 100)}%"></i></span></td><td>${st.news ? `<span class="pill new">${st.news} nouv.</span> ` : ''}${st.orders}</td><td>${st.last ? esc(st.last.slice(0, 16)) : '—'}</td><td><a class="btn sm" href="/super/boutique/${u.id}/activite">Voir le détail</a></td></tr>`).join('') || '<tr><td colspan="7">Aucune boutique.</td></tr>'}</table></div>
  <h3 class="sec">Derniers mouvements <span class="hint">(toutes boutiques)</span></h3>
  ${actTable(db.prepare('SELECT a.*, u.shop_name FROM activity a JOIN users u ON u.id=a.shop_id ORDER BY a.id DESC LIMIT 25').all(), true)}
  ${searchBar('/super', q)}
  <h3 class="sec">Commandes <span class="hint">(toutes boutiques)</span></h3>${ordersTable(loadOrders(req.user, q), true)}
  <h3 class="sec">Demandes de rappel</h3>${inquiriesTable(loadInquiries(req.user, q), true)}

  <h3 class="sec">Boutiques et leurs gérants <span class="hint">(ce sont eux qui publient les annonces)</span></h3>
  <div class="tablewrap"><table><tr><th>Boutique</th><th>E-mail</th><th>Téléphone</th><th>Annonces</th><th>Statut</th><th></th></tr>${acctRows(shops) || '<tr><td colspan="6">Aucune boutique.</td></tr>'}</table></div>

  <div class="guide reveal" style="margin-top:8px"><b>Nouveau compte</b><p style="margin:10px 0 14px">Ajoutez une boutique et son gérant (il publie les annonces), ou un autre super administrateur.</p><a class="btn" href="/super/compte/nouveau">+ Créer un compte</a></div>

  <h3 class="sec">Super administrateurs</h3>
  <div class="tablewrap"><table><tr><th>Nom</th><th>E-mail</th><th>Téléphone</th><th>Annonces</th><th>Statut</th><th></th></tr>${acctRows(admins)}</table></div>

  <h3 class="sec">Toutes les annonces <span class="hint">(valeur du catalogue : ${fcfa(total)})</span></h3>
  <div class="tablewrap"><table><tr><th></th><th>Moto</th><th>Boutique</th><th>Type</th><th>Prix</th><th>Statut</th><th></th></tr>${motoRows(motos, { showShop: true }) || '<tr><td colspan="7">Aucune moto.</td></tr>'}</table></div>
  </div></section>` });
});

const actTable = (rows, showShop) => rows.length ? `<div class="tablewrap"><table><tr><th>Date</th>${showShop ? '<th>Boutique</th>' : ''}<th>Mouvement</th><th>Détail</th><th>Montant</th></tr>${rows.map((r) => { const k = ACT[r.kind] || ['•', r.kind]; return `<tr><td>${esc(r.created_at.slice(0, 16))}</td>${showShop ? `<td>${esc(r.shop_name)}</td>` : ''}<td><span class="pill ${r.kind === 'vente' ? 'on' : r.kind === 'suppression' ? 'off' : 'new'}">${k[0]} ${k[1]}</span></td><td>${esc(r.label)}</td><td>${r.amount != null ? fcfa(r.amount) : ''}</td></tr>`; }).join('')}</table></div>` : '<div class="empty" style="margin-bottom:28px">Aucun mouvement pour le moment.</div>';
app.get('/super/boutique/:id(\\d+)/activite', requireAuth, requireSuper, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=? AND status='approved'").get(req.params.id);
  if (!u) { flash(res, 'err', 'Boutique introuvable.'); return res.redirect('/super'); }
  const st = shopStats(u.id);
  const motos = db.prepare('SELECT m.*, u.shop_name, u.active FROM motos m JOIN users u ON u.id=m.user_id WHERE m.user_id=? ORDER BY m.id DESC').all(u.id);
  const orders = db.prepare('SELECT o.*, ? AS shop_name FROM orders o WHERE shop_id=? ORDER BY id DESC LIMIT 100').all(u.shop_name, u.id);
  const acts = db.prepare('SELECT a.*, ? AS shop_name FROM activity a WHERE shop_id=? ORDER BY id DESC LIMIT 100').all(u.shop_name, u.id);
  res.locals.render({ title: `Activité – ${u.shop_name}`, body: `<section><div class="wrap">
  ${dashBanner({ tag: 'Détail de la boutique', title: esc(u.shop_name), sub: `${esc(u.email)} · ${esc(u.phone || '')} · ${u.active ? 'compte actif' : 'compte suspendu'}`, actions: '<a class="btn alt" href="/super">← Retour au tableau de bord</a>' })}
  <div class="kpis">${kpiX(st.stock, 'Motos en stock')}${kpiMoney(st.stockValue, 'Valeur du stock')}${kpiX(st.sold, 'Motos vendues')}${kpiMoney(st.revenue, 'Ventes réalisées', 'gold')}</div>
  <div class="kpis">${kpiX(st.news, 'Commandes nouvelles')}${kpiX(st.confirmed, 'Confirmées')}${kpiX(st.delivered, 'Livrées')}${kpiX(st.cancelled, 'Annulées')}</div>
  <h3 class="sec">Mouvements de la boutique</h3>${actTable(acts, false)}
  <h3 class="sec">Commandes</h3>${ordersTable(orders, false)}
  <h3 class="sec">Annonces (${st.total})</h3>
  ${motos.length ? `<div class="tablewrap"><table><tr><th></th><th>Moto</th><th>Type</th><th>Prix</th><th>Statut</th><th></th></tr>${motoRows(motos)}</table></div>` : '<div class="empty">Aucune annonce.</div>'}
  </div></section>` });
});

app.get('/super/sauvegarde', requireAuth, requireSuper, (req, res) => {
  try { res.download(backup(), `lobane-sauvegarde-${new Date().toISOString().slice(0, 10)}.db`); }
  catch (e) { console.error('sauvegarde', e); flash(res, 'err', 'Sauvegarde impossible pour le moment.'); res.redirect('/super'); }
});

app.get('/super/compte/nouveau', requireAuth, requireSuper, (req, res) => {
  res.locals.render({ title: 'Créer un compte', body: `<section><div class="wrap narrow" style="max-width:680px"><p class="crumbs"><a href="/super">Super administrateur</a><span>›</span>Créer un compte</p>
  <h2>Créer un compte</h2><p class="sub">Une boutique et son gérant (il publie les annonces et suit les commandes), ou un autre super administrateur.</p>
  <form class="stack panel" method="post" action="/super/boutique"><div class="two"><label>Nom de la boutique<input name="shop_name" required maxlength="80" placeholder="Ex. Moto Plus Abidjan"></label><label>E-mail de connexion<input type="email" name="email" required></label></div>
  <div class="two"><label>Téléphone<input name="phone" maxlength="30"></label><label>WhatsApp <span class="hint">(les commandes arrivent ici)</span><input name="whatsapp" maxlength="30"></label></div>
  <div class="two"><label>Type de compte<select name="role"><option value="admin">Gérant de boutique (publie des annonces)</option><option value="super">Super administrateur (voit et gère tout)</option></select></label>
  <label>Mot de passe initial <span class="hint">(8 caractères minimum)</span><input name="password" required minlength="8" autocomplete="off"></label></div>
  <div class="actions"><button class="btn" type="submit">Créer le compte</button><a class="btn alt" href="/super">Annuler</a></div></form></div></section>` });
});

app.post('/super/boutique', requireAuth, requireSuper, (req, res) => {
  const b = req.body; const email = String(b.email || '').trim().toLowerCase(); const shop = String(b.shop_name || '').trim().slice(0, 80);
  const role = b.role === 'super' ? 'super' : 'admin';
  if (!shop || !EMAIL_RE.test(email) || String(b.password || '').length < 8) { flash(res, 'err', 'Vérifiez le nom, l\'e-mail et le mot de passe (8 caractères minimum).'); return res.redirect('/super/compte/nouveau'); }
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) { flash(res, 'err', 'Un compte existe déjà avec cet e-mail.'); return res.redirect('/super/compte/nouveau'); }
  db.prepare('INSERT INTO users (email,password_hash,role,shop_name,phone,whatsapp) VALUES (?,?,?,?,?,?)').run(email, bcrypt.hashSync(String(b.password), 10), role, shop, String(b.phone || '').slice(0, 30), String(b.whatsapp || b.phone || '').slice(0, 30));
  flash(res, 'ok', role === 'super' ? `Super administrateur « ${shop} » créé.` : `Boutique « ${shop} » créée : son gérant peut se connecter et publier.`); res.redirect('/super');
});

// action sur un compte (jamais sur soi-même ; il doit toujours rester un super administrateur actif)
const accountAction = (fn, msg, { guardLastSuper = false } = {}) => (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) { flash(res, 'err', 'Compte introuvable.'); return res.redirect('/super'); }
  if (u.id === req.user.id) { flash(res, 'err', 'Vous ne pouvez pas faire cela sur votre propre compte.'); return res.redirect('/super'); }
  if (guardLastSuper && u.role === 'super' && db.prepare("SELECT COUNT(*) c FROM users WHERE role='super' AND active=1 AND id<>?").get(u.id).c < 1) {
    flash(res, 'err', 'Il doit rester au moins un super administrateur actif.'); return res.redirect('/super');
  }
  fn(u, req); flash(res, 'ok', msg(u)); res.redirect('/super');
};
app.post('/super/boutique/:id(\\d+)/valider', requireAuth, requireSuper, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=? AND status='pending'").get(req.params.id);
  if (!u) { flash(res, 'err', 'Demande introuvable ou déjà traitée.'); return res.redirect('/super'); }
  db.prepare("UPDATE users SET status='approved' WHERE id=?").run(u.id);
  flash(res, 'ok', `Compte « ${u.shop_name} » validé : le gérant peut maintenant se connecter et publier. Prévenez-le au ${u.phone}.`); res.redirect('/super');
});
app.post('/super/boutique/:id(\\d+)/refuser', requireAuth, requireSuper, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=? AND status='pending'").get(req.params.id);
  if (!u) { flash(res, 'err', 'Demande introuvable ou déjà traitée.'); return res.redirect('/super'); }
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  flash(res, 'ok', `Demande « ${u.shop_name} » refusée et supprimée.`); res.redirect('/super');
});
app.post('/super/boutique/:id(\\d+)/suspendre', requireAuth, requireSuper, accountAction((u) => db.prepare('UPDATE users SET active=0 WHERE id=?').run(u.id), (u) => `${u.shop_name} est suspendu (ses annonces sont masquées).`, { guardLastSuper: true }));
app.post('/super/boutique/:id(\\d+)/activer', requireAuth, requireSuper, accountAction((u) => db.prepare('UPDATE users SET active=1 WHERE id=?').run(u.id), (u) => `${u.shop_name} est réactivé.`));
app.post('/super/boutique/:id(\\d+)/mdp', requireAuth, requireSuper, (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length < 8) { flash(res, 'err', 'Mot de passe trop court.'); return res.redirect('/super'); }
  return accountAction((u) => db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(pw, 10), u.id), (u) => `Mot de passe de ${u.shop_name} modifié.`)(req, res);
});
app.post('/super/boutique/:id(\\d+)/supprimer', requireAuth, requireSuper, accountAction((u) => {
  db.prepare('SELECT id FROM motos WHERE user_id=?').all(u.id).forEach((m) => removeMotoFiles(m.id));
  rmFile(u.logo);
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
}, (u) => `${u.shop_name} supprimé.`, { guardLastSuper: true }));

app.get('/super/boutique/:id(\\d+)/modifier', requireAuth, requireSuper, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) { flash(res, 'err', 'Compte introuvable.'); return res.redirect('/super'); }
  if (u.id === req.user.id) return res.redirect('/admin/profil');
  res.locals.render({ title: `Modifier ${u.shop_name}`, body: `<section><div class="wrap narrow" style="max-width:620px"><h2>Modifier le compte</h2><p class="sub">${u.role === 'super' ? 'Super administrateur' : 'Gérant de boutique'}</p>
  <form class="stack panel" method="post" action="/super/boutique/${u.id}/modifier" enctype="multipart/form-data">
  <label>Nom de la boutique<input name="shop_name" required maxlength="80" value="${esc(u.shop_name)}"></label>
  <label>E-mail de connexion<input type="email" name="email" required value="${esc(u.email)}"></label>
  <div class="two"><label>Téléphone<input name="phone" maxlength="30" value="${esc(u.phone)}"></label><label>WhatsApp<input name="whatsapp" maxlength="30" value="${esc(u.whatsapp)}"></label></div>
  <label>Logo de la boutique <span class="hint">(facultatif)</span>${u.logo ? `<span class="logoprev"><img src="/uploads/${esc(u.logo)}" alt="" width="56" height="56"><span class="chk"><input type="checkbox" name="remove_logo" value="1"> Retirer le logo</span></span>` : ''}<input type="file" name="logo" accept="image/jpeg,image/png,image/webp"></label>
  <div class="actions"><button class="btn" type="submit">Enregistrer</button><a class="btn alt" href="/super">Annuler</a></div></form></div></section>` });
});
app.post('/super/boutique/:id(\\d+)/modifier', requireAuth, requireSuper, handleUpload, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u || u.id === req.user.id) { discardSaved(req.saved); flash(res, 'err', 'Compte introuvable.'); return res.redirect('/super'); }
  const back = `/super/boutique/${u.id}/modifier`;
  const email = String(req.body.email || '').trim().toLowerCase(); const shop = String(req.body.shop_name || '').trim().slice(0, 80);
  if (!shop || !EMAIL_RE.test(email)) { discardSaved(req.saved); flash(res, 'err', 'Vérifiez le nom et l\'e-mail.'); return res.redirect(back); }
  if (db.prepare('SELECT 1 FROM users WHERE email=? AND id<>?').get(email, u.id)) { discardSaved(req.saved); flash(res, 'err', 'Un autre compte utilise déjà cet e-mail.'); return res.redirect(back); }
  db.prepare('UPDATE users SET shop_name=?, email=?, phone=?, whatsapp=? WHERE id=?').run(shop, email, String(req.body.phone || '').slice(0, 30), String(req.body.whatsapp || '').slice(0, 30), u.id);
  if (req.saved.logo || isOn(req.body.remove_logo)) { rmFile(u.logo); db.prepare('UPDATE users SET logo=? WHERE id=?').run(req.saved.logo || null, u.id); }
  flash(res, 'ok', `${shop} mis à jour.`); res.redirect('/super');
});

// ---- 404 + erreurs ----
app.use((req, res) => res.status(404).send(layout({ title: 'Page introuvable', user: req.user, body: '<section><div class="wrap"><h2>Page introuvable</h2><p class="sub">Cette page n\'existe pas.</p><a class="btn" href="/">Retour à l\'accueil</a></div></section>' })));
app.use((err, req, res, next) => { console.error(err); res.status(500).send(layout({ title: 'Erreur', body: '<section><div class="wrap"><h2>Une erreur est survenue</h2><p class="sub">Réessayez dans un instant.</p></div></section>' })); });

const created = seed(); syncImages();
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
