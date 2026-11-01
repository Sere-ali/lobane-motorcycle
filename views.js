const { TYPES } = require('./db');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fcfa = (n) => new Intl.NumberFormat('fr-FR').format(n).replace(/ | /g, ' ') + ' F CFA';
const digits = (s) => String(s || '').replace(/\D/g, '');

// Sans photo : le logo de la marque (pas de dessin). Avec photo : image en fondu à l'affichage.
const placeholder = () => `<div class="ph"><img src="/img/logo-badge-96.png" width="96" height="96" alt="" loading="lazy"><span>Photo bientôt disponible</span></div>`;
const motoImg = (m, eager = false) => (m.image ? `<img class="fade" src="/uploads/${esc(m.image)}" alt="${esc(m.title)}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">` : placeholder());

const SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<g id="moto"><circle cx="90" cy="150" r="46" fill="none" stroke="#111" stroke-width="10"/><circle cx="90" cy="150" r="14" fill="#111"/>
<circle cx="310" cy="150" r="46" fill="none" stroke="#111" stroke-width="10"/><circle cx="310" cy="150" r="14" fill="#111"/>
<path d="M90 150 L150 100 L225 100 L310 150" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M150 100 L135 70 L175 60 L240 66 L255 100 Z" fill="currentColor"/>
<path d="M232 70 L262 40 L290 44" fill="none" stroke="#111" stroke-width="8" stroke-linecap="round"/>
<rect x="170" y="104" width="52" height="30" rx="8" fill="#111"/><path d="M262 100 L310 150" stroke="#111" stroke-width="8" stroke-linecap="round"/>
<rect x="120" y="58" width="70" height="14" rx="7" fill="#111"/></g>
<g id="i-city" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="32" r="6"/><circle cx="37" cy="32" r="6"/><path d="M11 32 L20 20 H30 L37 32 M20 20 L17 14 H22 M30 20 L34 13 H39"/></g>
<g id="i-off" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 39 L18 14 L26 27 L31 20 L44 39 Z"/></g>
<g id="i-sport" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6 V42 M12 8 H38 L32 17 L38 26 H12"/></g>
<g id="i-work" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16 L24 7 L42 16 V34 L24 43 L6 34 Z M6 16 L24 25 L42 16 M24 25 V43"/></g>
<g id="i-scoot" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="36" r="5"/><circle cx="38" cy="36" r="5"/><path d="M11 36 H26 L30 12 H36 M30 22 H37 L38 36"/></g>
<g id="i-gear" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="24" cy="24" r="8"/><path d="M24 5 V12 M24 36 V43 M5 24 H12 M36 24 H43 M10 10 L15 15 M33 33 L38 38 M38 10 L33 15 M15 33 L10 38"/></g>
</defs></svg>`;
const TYPE_ICON = { 'Moto de ville': 'i-city', 'Tout-terrain': 'i-off', 'Sport / grosse cylindrée': 'i-sport', 'Travail / livraison': 'i-work', Scooter: 'i-scoot', 'Pièces & pneus': 'i-gear' };
const typeIcon = (t) => `<svg viewBox="0 0 48 48" aria-hidden="true"><use href="#${TYPE_ICON[t] || 'i-city'}"/></svg>`;

function layout({ title, body, user, flash, desc = '', page = '' }) {
  const nav = (user
    ? `<a href="${user.role === 'super' ? '/super' : '/admin'}">Mon espace</a><form method="post" action="/deconnexion" class="inline"><button type="submit">Déconnexion</button></form>`
    : `<a href="/connexion">Espace boutique</a>`);
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><meta name="description" content="${esc(desc || 'Lobane Motorcycle : vente de motos et pièces détachées à Abidjan.')}">
<meta name="theme-color" content="#1f6b12"><link rel="icon" type="image/png" href="/img/logo-badge-96.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@1,800;1,900&family=Barlow:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/style.css"><script src="/app.js" defer></script></head>
<body class="${esc(page)}"><a class="skip" href="#contenu">Aller au contenu</a>${SPRITE}
<header class="site"><div class="wrap">
  <a href="/" class="brand" aria-label="Lobane Motorcycle – accueil"><img src="/img/logo-badge-96.png" width="50" height="50" alt=""><span class="brand-t"><b>Lobane</b><i>Motorcycle</i></span></a>
  <button class="navtoggle" type="button" aria-expanded="false" aria-controls="menu" aria-label="Ouvrir le menu"><span></span></button>
  <nav class="main" id="menu" aria-label="Navigation principale"><a href="/">Accueil</a><a href="/motos">Toutes les motos</a><a href="/#contact">Contact</a>${nav}</nav>
</div></header>
${flash ? `<div class="wrap"><div class="flash ${esc(flash.type)}" role="status">${esc(flash.msg)}</div></div>` : ''}
<main id="contenu">${body}</main>
<footer class="site"><div class="wrap">
  <div><div class="fbrand"><img src="/img/logo-badge-96.png" width="64" height="64" alt="Logo Lobane Motorcycle"><div><h4 style="margin:0">Lobane Motorcycle</h4><span>Vente de moto et pièces détachées.<br>Super 2016 Power.</span></div></div></div>
  <div><h4>Liens</h4><ul><li><a href="/">Accueil</a></li><li><a href="/motos">Toutes les motos</a></li><li><a href="/connexion">Espace boutique</a></li></ul></div>
  <div id="contact"><h4>Contact</h4><ul><li><a href="tel:+2250505137178">+225 05 05 13 71 78</a></li><li><a href="tel:+2250777673369">+225 07 77 67 33 69</a></li><li><a href="tel:+2250769128212">+225 07 69 12 82 12</a></li><li>Lobanemotocycle@gmail.com</li><li>3 Ampoules, Koumassi – Abidjan</li></ul></div>
</div><p class="wrap copy">© ${new Date().getFullYear()} Lobane Motorcycle – Tous droits réservés</p></footer>
<a class="float" href="https://wa.me/2250505137178" target="_blank" rel="noopener" aria-label="Écrire sur WhatsApp">💬 <span>WhatsApp</span></a>
</body></html>`;
}

function motoCard(m) {
  return `<article class="card moto reveal">
  <a href="/moto/${m.id}" class="imgbox" aria-label="Voir ${esc(m.title)}">${motoImg(m)}${m.status === 'vendu' ? '<span class="soldtag">Vendu</span>' : ''}</a>
  <div class="info">
    <span class="shop">${esc(m.shop_name)}</span>
    <h3><a href="/moto/${m.id}">${esc(m.title)}</a></h3>
    <small>${esc(m.type)}${m.brand ? ' · ' + esc(m.brand) : ''}</small>
    <div class="row"><span class="price">${fcfa(m.price)}</span><a class="btn alt sm" href="/moto/${m.id}">Détails</a></div>
    ${m.status === 'vendu' ? '' : `<a class="btn wa order" href="https://wa.me/${digits(m.whatsapp || m.phone) || '2250505137178'}?text=${encodeURIComponent(`Bonjour, je veux commander la moto « ${m.title} » (${fcfa(m.price)}) vue sur le site Lobane Motorcycle.`)}" target="_blank" rel="noopener">💬 Commander</a>`}
  </div></article>`;
}

function filterForm({ q = '', type = '', shop = '', min = '', max = '' }, shops) {
  return `<form class="filters" method="get" action="/motos">
  <input name="q" value="${esc(q)}" placeholder="Rechercher (marque, modèle…)">
  <select name="type"><option value="">Tous les types</option>${TYPES.map((t) => `<option ${t === type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
  <select name="shop"><option value="">Toutes les boutiques</option>${shops.map((s) => `<option value="${s.id}" ${String(s.id) === String(shop) ? 'selected' : ''}>${esc(s.shop_name)}</option>`).join('')}</select>
  <input name="min" type="number" min="0" value="${esc(min)}" placeholder="Prix min">
  <input name="max" type="number" min="0" value="${esc(max)}" placeholder="Prix max">
  <button class="btn" type="submit">Filtrer</button></form>`;
}

function motoForm(m = {}, action, label) {
  return `<form class="stack" method="post" action="${action}" enctype="multipart/form-data">
  <label>Nom de la moto<input name="title" required maxlength="120" value="${esc(m.title)}"></label>
  <div class="two"><label>Marque<input name="brand" maxlength="60" value="${esc(m.brand)}"></label>
  <label>Type<select name="type" required>${TYPES.map((t) => `<option ${t === m.type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label></div>
  <div class="two"><label>Prix (F CFA)<input name="price" type="number" min="0" step="1000" required value="${esc(m.price)}"></label>
  <label>Statut<select name="status"><option value="disponible" ${m.status !== 'vendu' ? 'selected' : ''}>Disponible</option><option value="vendu" ${m.status === 'vendu' ? 'selected' : ''}>Vendu</option></select></label></div>
  <label>Description<textarea name="description" rows="4" maxlength="2000">${esc(m.description)}</textarea></label>
  <label>Photo (JPG, PNG ou WebP, 5 Mo max)<input type="file" name="image" accept="image/jpeg,image/png,image/webp"></label>
  ${m.image ? `<p class="hint">Photo actuelle : <img class="thumb" src="/uploads/${esc(m.image)}" alt=""> – laissez vide pour la conserver.</p>` : ''}
  <button class="btn" type="submit">${label}</button></form>`;
}

module.exports = { esc, fcfa, digits, layout, motoCard, filterForm, motoForm, motoImg, typeIcon, TYPES };
