/* Lobane Motorcycle – comportements du site (menu mobile, animations au défilement) */
(function () {
  'use strict';
  var doc = document, root = doc.documentElement;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 1. Menu mobile
  var header = doc.querySelector('header.site'), toggle = doc.querySelector('.navtoggle');
  if (header && toggle) {
    var setOpen = function (open) {
      header.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Fermer le menu' : 'Ouvrir le menu');
    };
    toggle.addEventListener('click', function () { setOpen(!header.classList.contains('open')); });
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
    doc.addEventListener('click', function (e) { if (!header.contains(e.target)) setOpen(false); });
    header.querySelectorAll('nav a').forEach(function (a) { a.addEventListener('click', function () { setOpen(false); }); });
    window.addEventListener('resize', function () { if (window.innerWidth > 860) setOpen(false); });
  }

  // 2. En-tête compact au défilement
  if (header) {
    var ticking = false;
    var onScroll = function () {
      if (ticking) return; ticking = true;
      requestAnimationFrame(function () { header.classList.toggle('scrolled', window.scrollY > 12); ticking = false; });
    };
    window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
  }

  // 3. Tableaux : libellés des colonnes pour l'affichage mobile
  doc.querySelectorAll('table').forEach(function (t) {
    var heads = Array.prototype.map.call(t.querySelectorAll('tr:first-child th'), function (th) { return th.textContent.trim(); });
    if (!heads.length) return;
    t.querySelectorAll('tr').forEach(function (tr) {
      Array.prototype.forEach.call(tr.children, function (td, i) { if (td.tagName === 'TD') td.setAttribute('data-label', heads[i] || ''); });
    });
  });

  // 4. Apparition au défilement
  var items = doc.querySelectorAll('.reveal');
  if (items.length) {
    root.classList.add('js');
    if (reduce || !('IntersectionObserver' in window)) {
      items.forEach(function (el) { el.classList.add('in'); });
    } else {
      // décalage en cascade dans une même grille
      doc.querySelectorAll('.grid, .points, .kpis').forEach(function (g) {
        Array.prototype.forEach.call(g.children, function (c, i) { if (c.classList.contains('reveal')) c.style.setProperty('--i', Math.min(i, 6)); });
      });
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
      }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
      items.forEach(function (el) { io.observe(el); });
      // filet de sécurité : tout devient visible après 4 s
      setTimeout(function () { items.forEach(function (el) { el.classList.add('in'); }); }, 4000);
    }
  }

  // 5. Compteurs animés
  var counters = doc.querySelectorAll('[data-count]');
  var run = function (el) {
    var end = parseFloat(el.getAttribute('data-count')), suffix = el.getAttribute('data-suffix') || '';
    if (reduce || isNaN(end)) { el.textContent = (end || 0) + suffix; return; }
    var t0 = null, dur = 1400;
    var step = function (t) {
      if (t0 === null) t0 = t;
      var p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(end * e) + suffix;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  if (counters.length && 'IntersectionObserver' in window) {
    var co = new IntersectionObserver(function (es) { es.forEach(function (en) { if (en.isIntersecting) { run(en.target); co.unobserve(en.target); } }); }, { threshold: 0.6 });
    counters.forEach(function (c) { co.observe(c); });
  } else counters.forEach(run);
})();
