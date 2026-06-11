/**
 * landing.js — behaviour for the landing page (index.html).
 *
 * Kept external (no inline scripts) so the site-wide CSP can stay
 * `script-src 'self'`. Three jobs:
 *   1. Reveal-on-scroll animations.
 *   2. Hero image fallback (hide if the file is missing).
 *   3. Apply admin-managed content from /api/content — hero headline/sub and
 *      the gallery — so the Admin → Front Page manager actually drives the
 *      live site.
 */

// ── 1. Reveal on scroll ──────────────────────────────────────────────────────
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach(el => io.observe(el));

// ── 2. Hero image fallback ───────────────────────────────────────────────────
const heroImg = document.getElementById('hero-bg-img');
if (heroImg) heroImg.addEventListener('error', () => { heroImg.style.display = 'none'; });

// ── 2b. Scroll progress line + slider rail — the top line fills as you read,
//        the right-edge thumb mirrors your position, and the hero scroll-cue
//        fades once you've started moving.
const progress = document.getElementById('scroll-progress');
const cue = document.querySelector('.scroll-cue');
const rail = document.getElementById('scroll-rail');
const railTrack = rail ? rail.querySelector('.rail-track') : null;
const thumb = document.getElementById('rail-thumb');
// Synchronous on purpose — NO requestAnimationFrame deferral. rAF can be
// frozen entirely in throttled/embedded tabs, which left the progress line
// and rail thumb dead. Three style writes per scroll event are trivial.
function onScroll() {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  const t = max > 0 ? window.scrollY / max : 0;
  if (progress) progress.style.width = (t * 100).toFixed(2) + '%';
  if (railTrack && thumb) {
    const span = railTrack.clientHeight - thumb.offsetHeight;
    if (span > 0) thumb.style.top = (t * span).toFixed(1) + 'px';
  }
  if (cue) {
    cue.style.opacity = window.scrollY > 40 ? '0' : '';
    cue.style.pointerEvents = window.scrollY > 40 ? 'none' : '';
  }
}
window.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('resize', onScroll, { passive: true });
onScroll();

// ── 2c. Reliable smooth scrolling — our own rAF tween. CSS
//        scroll-behavior:smooth (and scrollTo behavior:'smooth') silently
//        does NOTHING in some environments, which made the scroll cue and
//        nav anchors feel dead. Direct scrollTop writes always work; we
//        animate them ourselves.
const scrollerEl = document.scrollingElement || document.documentElement;
let tweenId = 0;
function smoothScrollTo(targetY, duration = 700) {
  const startY = scrollerEl.scrollTop;
  const max = scrollerEl.scrollHeight - window.innerHeight;
  const endY = Math.min(Math.max(0, targetY), Math.max(0, max));
  const dist = endY - startY;
  if (Math.abs(dist) < 1) return;
  const id = ++tweenId;
  const t0 = performance.now();
  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  let done = false;
  const step = (now) => {
    if (id !== tweenId) return;                  // superseded by a newer tween
    const t = Math.min(1, (now - t0) / duration);
    scrollerEl.scrollTop = startY + dist * easeInOutCubic(t);
    if (t < 1) requestAnimationFrame(step);
    else done = true;
  };
  requestAnimationFrame(step);
  // Watchdog: if rAF is frozen (throttled/embedded tab), jump straight to the
  // destination so the click NEVER reads as "nothing happened".
  setTimeout(() => {
    if (id === tweenId && !done) { scrollerEl.scrollTop = endY; done = true; }
  }, duration + 150);
}
// Any user scroll input cancels an in-flight tween (no fighting the wheel).
window.addEventListener('wheel', () => { tweenId++; }, { passive: true });
window.addEventListener('touchmove', () => { tweenId++; }, { passive: true });

// In-page anchors (top nav, scroll cue, footer) → tweened scroll.
for (const a of document.querySelectorAll('a[href^="#"]')) {
  a.addEventListener('click', (e) => {
    const target = document.querySelector(a.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    smoothScrollTo(target.getBoundingClientRect().top + scrollerEl.scrollTop, 750);
  });
}

// ── 2d. Rail interaction — grab the thumb (or press anywhere on the rail)
//        and the page follows live. Pointer capture keeps the drag smooth
//        even when the cursor leaves the rail.
if (rail && railTrack && thumb) {
  let dragging = false;
  const scrollToPointer = (e) => {
    const r = railTrack.getBoundingClientRect();
    const th = thumb.offsetHeight;
    const span = r.height - th;
    if (span <= 0) return;
    const t = Math.min(1, Math.max(0, (e.clientY - r.top - th / 2) / span));
    const max = scrollerEl.scrollHeight - window.innerHeight;
    tweenId++;                                   // kill any anchor tween
    scrollerEl.scrollTop = t * max;              // direct write — always works
    onScroll();                                  // thumb/progress sync NOW
  };
  const startDrag = (e) => {
    dragging = true;
    rail.classList.add('dragging');
    if (e.pointerId !== undefined) {
      try { rail.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
    }
    scrollToPointer(e);
    e.preventDefault();
  };
  const moveDrag = (e) => { if (dragging) scrollToPointer(e); };
  const endDrag = () => { dragging = false; rail.classList.remove('dragging'); };
  // Pointer events for real input; mouse events as an idempotent fallback for
  // environments that synthesize only legacy events. Double-firing is harmless
  // (same coordinates → same scrollTop).
  rail.addEventListener('pointerdown', startDrag);
  rail.addEventListener('pointermove', moveDrag);
  rail.addEventListener('pointerup', endDrag);
  rail.addEventListener('pointercancel', endDrag);
  rail.addEventListener('mousedown', startDrag);
  window.addEventListener('mousemove', moveDrag, { passive: true });
  window.addEventListener('mouseup', endDrag, { passive: true });
}

// ── 3. Admin-managed content ────────────────────────────────────────────────
// The headline/sub are stored as admin-entered "rich text". We do NOT inject
// them as raw HTML — only text plus <br> and <em> survive, everything else is
// unwrapped to its text. That keeps the admin feature while making stored-XSS
// via KV content impossible.
function applyRichText(target, raw) {
  if (!target || typeof raw !== 'string' || !raw.trim()) return;
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const walk = (src, dst, allowEm) => {
    for (const node of src.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        dst.appendChild(document.createTextNode(node.textContent));
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();
        if (tag === 'br') {
          dst.appendChild(document.createElement('br'));
        } else if (tag === 'em' && allowEm) {
          const em = document.createElement('em');
          dst.appendChild(em);
          walk(node, em, false);
        } else {
          walk(node, dst, allowEm); // unwrap unknown tags, keep their text
        }
      }
    }
  };
  target.textContent = '';
  walk(doc.body, target, true);
}

function applyGallery(gallery) {
  const section = document.getElementById('gallery');
  const grid = document.getElementById('gallery-grid');
  if (!section || !grid || !Array.isArray(gallery)) return;
  const items = gallery.filter(g => g && typeof g.url === 'string' && g.url.trim());
  if (!items.length) return; // section stays hidden
  grid.textContent = '';
  for (const item of items.slice(0, 6)) {
    const url = item.url.trim();
    // Only http(s) or site-relative paths — nothing javascript:-shaped.
    if (!/^(https?:\/\/|\/)/i.test(url)) continue;
    const fig = document.createElement('figure');
    fig.className = 'gallery-item';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = item.caption || 'Printed city model';
    img.src = url;
    img.addEventListener('error', () => fig.remove());
    fig.appendChild(img);
    if (item.caption) {
      const cap = document.createElement('figcaption');
      cap.className = 'gallery-cap';
      cap.textContent = item.caption;
      fig.appendChild(cap);
    }
    grid.appendChild(fig);
  }
  if (grid.children.length) section.style.display = 'block';
}

(async () => {
  try {
    const resp = await fetch('/api/content');
    if (!resp.ok) return;
    const data = await resp.json();
    const c = data?.content;
    if (!c) return;
    applyRichText(document.getElementById('hero-headline'), c.heroHeadline);
    applyRichText(document.getElementById('hero-sub'), c.heroSub);
    applyGallery(c.gallery);
  } catch { /* static defaults remain */ }
})();
