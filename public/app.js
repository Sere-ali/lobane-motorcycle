/* Lobane Motorcycle – comportements du site (menu mobile, animations au défilement) */
(function () {
  'use strict';
  var doc = document, root = doc.documentElement;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  root.classList.add('js');

  // 0. Confirmations et saisie de mot de passe (remplace les attributs onsubmit, interdits par la CSP)
  doc.addEventListener('submit', function (e) {
    var f = e.target;
    if (f.hasAttribute && f.hasAttribute('data-confirm') && !window.confirm(f.getAttribute('data-confirm'))) { e.preventDefault(); return; }
    if (f.hasAttribute && f.hasAttribute('data-prompt-password')) {
      var p = window.prompt(f.getAttribute('data-prompt-password'));
      if (!p || p.length < 8) { e.preventDefault(); return; }
      f.elements.password.value = p;
    }
  });

  // 0b. Photos : fondu à l'affichage
  doc.querySelectorAll('img.fade').forEach(function (img) {
    var ok = function () { img.classList.add('loaded'); };
    if (img.complete && img.naturalWidth) ok(); else { img.addEventListener('load', ok); img.addEventListener('error', ok); }
  });
  setTimeout(function () { doc.querySelectorAll('img.fade').forEach(function (i) { i.classList.add('loaded'); }); }, 3000);

  // 0c. Titre du héros : mots animés un par un
  var h1 = doc.querySelector('.hero h1');
  if (h1 && !reduce) {
    var k = 0;
    var wrapWords = function (node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (n) {
        if (n.nodeType === 3) {
          var frag = doc.createDocumentFragment();
          n.textContent.split(/(\s+)/).forEach(function (part) {
            if (!part) return;
            if (/^\s+$/.test(part)) { frag.appendChild(doc.createTextNode(' ')); return; }
            var s = doc.createElement('span'); s.className = 'w'; s.style.setProperty('--k', k++); s.textContent = part; frag.appendChild(s);
          });
          node.replaceChild(frag, n);
        } else if (n.nodeType === 1) wrapWords(n);
      });
    };
    wrapWords(h1);
  }

  // 0d. Barre de progression de lecture
  var bar = doc.createElement('div'); bar.className = 'progress'; bar.setAttribute('aria-hidden', 'true'); doc.body.appendChild(bar);
  var onProg = function () {
    var h = root.scrollHeight - window.innerHeight;
    bar.style.transform = 'scaleX(' + (h > 0 ? Math.min(1, window.scrollY / h) : 0) + ')';
  };
  window.addEventListener('scroll', function () { requestAnimationFrame(onProg); }, { passive: true }); onProg();

  // 0e. Ondulation sur les boutons
  if (!reduce) {
    doc.addEventListener('pointerdown', function (e) {
      var b = e.target.closest && e.target.closest('.btn'); if (!b) return;
      var r = b.getBoundingClientRect(), d = Math.max(r.width, r.height) * 2;
      var s = doc.createElement('span'); s.className = 'ripple';
      s.style.cssText = 'width:' + d + 'px;height:' + d + 'px;left:' + (e.clientX - r.left - d / 2) + 'px;top:' + (e.clientY - r.top - d / 2) + 'px';
      b.appendChild(s); setTimeout(function () { s.remove(); }, 650);
    });
  }

  // 0f. Inclinaison 3D des cartes et de la photo du héros (souris uniquement)
  if (fine && !reduce) {
    var tiltEls = doc.querySelectorAll('.moto, .heroart-card');
    tiltEls.forEach(function (el) {
      el.classList.add('tilt');
      var max = el.classList.contains('heroart-card') ? 7 : 5;
      el.addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
        el.style.transition = 'transform .08s linear';
        el.style.transform = 'perspective(900px) rotateX(' + (-y * max).toFixed(2) + 'deg) rotateY(' + (x * max).toFixed(2) + 'deg) translateY(-4px)';
      });
      el.addEventListener('pointerleave', function () { el.style.transition = 'transform .5s cubic-bezier(.2,.7,.2,1)'; el.style.transform = ''; });
    });
  }

  // 0g. Visionneuse : clic sur la photo d'une fiche moto
  var big = doc.querySelector('.detail .imgbox img:not(.fade-skip)');
  if (big && big.getAttribute('src') && big.getAttribute('src').indexOf('/uploads/') === 0) {
    big.classList.add('zoomable');
    var lb = doc.createElement('div'); lb.className = 'lightbox'; lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-modal', 'true'); lb.setAttribute('aria-label', 'Photo agrandie');
    lb.innerHTML = '<button type="button" aria-label="Fermer">×</button><img alt="">';
    doc.body.appendChild(lb);
    var lbi = lb.querySelector('img'), close = function () { lb.classList.remove('on'); };
    big.addEventListener('click', function () { lbi.src = big.src; lbi.alt = big.alt; lb.classList.add('on'); lb.querySelector('button').focus(); });
    lb.addEventListener('click', close);
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  }

  // 0i. Boutons « magnétiques » dans le héros (souris uniquement)
  if (fine && !reduce) {
    doc.querySelectorAll('.hero .btn').forEach(function (b) {
      b.classList.add('magnet');
      b.addEventListener('pointermove', function (e) {
        var r = b.getBoundingClientRect();
        b.style.transform = 'translate(' + ((e.clientX - r.left - r.width / 2) * .18).toFixed(1) + 'px,' + ((e.clientY - r.top - r.height / 2) * .28).toFixed(1) + 'px)';
      });
      b.addEventListener('pointerleave', function () { b.style.transform = ''; });
    });
  }

  // 0j. Galerie de la fiche moto : miniatures cliquables
  doc.querySelectorAll('.thumb-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var main = doc.querySelector('.gallery .imgbox img'); if (!main) return;
      main.src = btn.getAttribute('data-src');
      doc.querySelectorAll('.thumb-btn').forEach(function (b) { b.classList.toggle('on', b === btn); });
    });
  });

  // 0k. Listes déroulantes qui s'envoient seules (changer le statut d'une commande)
  doc.querySelectorAll('select[data-autosubmit]').forEach(function (sel) {
    sel.addEventListener('change', function () { sel.form.submit(); });
  });

  // 0h. Léger décalage (parallaxe) des motifs du héros
  var hero = doc.querySelector('.hero');
  if (hero && !reduce) {
    window.addEventListener('scroll', function () { hero.style.setProperty('--py', Math.min(60, window.scrollY * .12).toFixed(1) + 'px'); }, { passive: true });
  }

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
