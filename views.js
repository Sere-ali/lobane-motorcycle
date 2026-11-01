const { TYPES } = require('./db');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Version des fichiers CSS/JS : change à chaque modification, ce qui force les navigateurs à recharger (plus de page cassée par un ancien cache)
const ASSET_V = crypto.createHash('sha1').update(['style.css', 'app.js'].map((f) => fs.readFileSync(path.join(__dirname, 'public', f))).join('|')).digest('hex').slice(0, 10);

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

function layout({ title, body, user, flash, desc = '', page = '', ride = false, badge = 0 }) {
  const nav = (user
    ? `${user.role === 'super' ? '<a class="navcta" href="/super/compte/nouveau">+ Créer un compte</a>' : ''}<a href="${user.role === 'super' ? '/super' : '/admin'}">Mon espace${badge ? ` <span class="navbadge" aria-label="${badge} nouveauté${badge > 1 ? 's' : ''}">${badge}</span>` : ''}</a><form method="post" action="/deconnexion" class="inline"><button type="submit">Déconnexion</button></form>`
    : `<a href="/connexion">Espace boutique</a>`);
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><meta name="description" content="${esc(desc || 'Lobane Motorcycle : vente de motos et pièces détachées à Abidjan.')}">
<meta name="theme-color" content="#1f6b12"><link rel="icon" type="image/png" href="/img/logo-badge-96.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@1,800;1,900&family=Barlow:wght@400;500;600;700&display=swap">
<style>.bgride{position:fixed;left:0;right:0;bottom:0;height:150px;overflow:hidden;z-index:-1;pointer-events:none}.bgride .ride-bike{position:absolute;bottom:14px;left:0;height:130px;width:156px}.bgride img{width:100%;height:100%;object-fit:contain}</style>
<link rel="stylesheet" href="/style.css?v=${ASSET_V}"><script src="/app.js?v=${ASSET_V}" defer></script></head>
<body class="${esc(page)}"><a class="skip" href="#contenu">Aller au contenu</a>${SPRITE}
${ride ? '<div class="bgride" aria-hidden="true"><div class="ride-bike"><img src="/img/demo/honda-winner-r-2026.jpg" width="1200" height="1000" alt="" decoding="async"></div><div class="ride-road"></div></div>' : ''}
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

const km = (n) => new Intl.NumberFormat('fr-FR').format(n) + ' km';
const specLine = (m) => [m.year, m.mileage != null ? km(m.mileage) : null, m.color].filter(Boolean).map(esc).join(' · ');
const etatBadge = (m) => `<span class="bdg ${m.etat === 'occasion' ? 'occ' : 'neuf'}">${m.etat === 'occasion' ? 'Occasion' : 'Neuf'}</span>`;
const shopLine = (m) => `<span class="shop">${m.logo ? `<img class="shoplogo" src="/uploads/${esc(m.logo)}" alt="" width="22" height="22" loading="lazy">` : ''}${esc(m.shop_name)}</span>`;

function motoCard(m) {
  const specs = specLine(m);
  return `<article class="card moto reveal">
  <a href="/moto/${m.id}" class="imgbox" aria-label="Voir ${esc(m.title)}">${motoImg(m)}${m.status === 'vendu' ? '<span class="soldtag">Vendu</span>' : ''}
    <span class="badges">${m.featured ? '<span class="bdg star">★ À la une</span>' : ''}${etatBadge(m)}</span></a>
  <div class="info">
    ${shopLine(m)}
    <h3><a href="/moto/${m.id}">${esc(m.title)}</a></h3>
    <small>${esc(m.type)}${m.brand ? ' · ' + esc(m.brand) : ''}${specs ? '<br>' + specs : ''}</small>
    <div class="row"><span class="price">${fcfa(m.price)}${m.negotiable ? '<em class="nego">négociable</em>' : ''}</span><a class="btn alt sm" href="/moto/${m.id}">Détails</a></div>
    ${m.status === 'vendu' ? '' : `<a class="btn wa order" href="/moto/${m.id}/commander">🛒 Commander</a>`}
  </div></article>`;
}

function filterForm({ q = '', type = '', shop = '', min = '', max = '', etat = '' }, shops) {
  return `<form class="filters" method="get" action="/motos">
  <input name="q" value="${esc(q)}" placeholder="Rechercher (marque, modèle…)">
  <select name="type"><option value="">Tous les types</option>${TYPES.map((t) => `<option ${t === type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
  <select name="etat"><option value="">Neuf et occasion</option><option value="neuf" ${etat === 'neuf' ? 'selected' : ''}>Neuf</option><option value="occasion" ${etat === 'occasion' ? 'selected' : ''}>Occasion</option></select>
  <select name="shop"><option value="">Toutes les boutiques</option>${shops.map((s) => `<option value="${s.id}" ${String(s.id) === String(shop) ? 'selected' : ''}>${esc(s.shop_name)}</option>`).join('')}</select>
  <input name="min" type="number" min="0" value="${esc(min)}" placeholder="Prix min">
  <input name="max" type="number" min="0" value="${esc(max)}" placeholder="Prix max">
  <button class="btn" type="submit">Filtrer</button></form>`;
}

function motoForm(m = {}, action, label, { photos = [], canFeature = false } = {}) {
  const thisYear = new Date().getFullYear();
  return `<form class="stack" method="post" action="${action}" enctype="multipart/form-data">
  <label>Nom de la moto<input name="title" required maxlength="120" value="${esc(m.title)}"></label>
  <div class="two"><label>Marque<input name="brand" maxlength="60" value="${esc(m.brand)}"></label>
  <label>Type<select name="type" required>${TYPES.map((t) => `<option ${t === m.type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label></div>
  <div class="two"><label>Prix (F CFA)<input name="price" type="number" min="0" step="1000" required value="${esc(m.price)}"></label>
  <label>Statut<select name="status"><option value="disponible" ${m.status !== 'vendu' ? 'selected' : ''}>Disponible</option><option value="vendu" ${m.status === 'vendu' ? 'selected' : ''}>Vendu</option></select></label></div>
  <div class="two"><label>État<select name="etat"><option value="neuf" ${m.etat !== 'occasion' ? 'selected' : ''}>Neuf</option><option value="occasion" ${m.etat === 'occasion' ? 'selected' : ''}>Occasion</option></select></label>
  <label>Année <span class="hint">(facultatif)</span><input name="year" type="number" min="1980" max="${thisYear + 1}" value="${esc(m.year)}" placeholder="${thisYear}"></label></div>
  <div class="two"><label>Kilométrage <span class="hint">(facultatif)</span><input name="mileage" type="number" min="0" max="1000000" step="1" value="${esc(m.mileage)}" placeholder="Ex. 12000"></label>
  <label>Couleur <span class="hint">(facultatif)</span><input name="color" maxlength="40" value="${esc(m.color)}" placeholder="Ex. Noir"></label></div>
  <label class="chk"><input type="checkbox" name="negotiable" value="1" ${m.negotiable ? 'checked' : ''}> Prix négociable</label>
  ${canFeature ? `<label class="chk"><input type="checkbox" name="featured" value="1" ${m.featured ? 'checked' : ''}> Mettre cette moto « À la une » (affichée en premier)</label>` : ''}
  <label>Description<textarea name="description" rows="4" maxlength="2000">${esc(m.description)}</textarea></label>
  <fieldset class="photos"><legend>Photos <span class="hint">(jusqu'à 5, la première est la couverture)</span></legend>
  ${photos.length ? `<div class="photo-grid">${photos.map((p, i) => `<div class="ph-item"><img src="/uploads/${esc(p.filename)}" alt="" loading="lazy">
    <label class="chk"><input type="radio" name="cover" value="${p.id}" ${i === 0 ? 'checked' : ''}> Couverture</label>
    <label class="chk"><input type="checkbox" name="remove_img" value="${p.id}"> Supprimer</label></div>`).join('')}</div>` : ''}
  <label>Ajouter des photos<input type="file" name="images" accept="image/jpeg,image/png,image/webp" multiple></label>
  <p class="hint">JPG, PNG ou WebP, 5 Mo maximum par photo. Elles sont réduites automatiquement pour charger vite sur téléphone.</p></fieldset>
  <button class="btn" type="submit">${label}</button></form>`;
}

module.exports = { esc, fcfa, digits, km, specLine, etatBadge, shopLine, layout, motoCard, filterForm, motoForm, motoImg, typeIcon, TYPES };
