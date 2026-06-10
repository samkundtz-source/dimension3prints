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
