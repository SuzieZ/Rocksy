#!/usr/bin/env node
/**
 * Rocksy Adventures — Shoe Page Generator
 *
 * Fetches shoe data from Google Sheets, saves shoe-data.json,
 * generates one SEO HTML page per shoe to /shoes/{slug}.html,
 * and regenerates /sitemap.xml.
 *
 * Run from repo root:  node scripts/generate-shoe-pages.js
 * Idempotent: re-running regenerates cleanly from fresh data.
 */

'use strict';
const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

// ── Config ────────────────────────────────────────────────────────────────────
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRmxyA2EDSWy23EqRbxYxdmM3IuHCL1Jg3sKgCx2Xle2RYfEZjN_60LCBbH1fl_7HVr_fboYQmOCBfE/pub?output=csv';
const SITE_ROOT = 'https://rocksyadventures.com';
const GA4_ID    = 'G-FLGTN7H34C';
const UTM       = '?utm_source=rocksy-shoe-finder&utm_medium=referral&utm_campaign=shoe-quiz';
const TODAY     = new Date().toISOString().slice(0, 10);

const ROOT      = path.resolve(__dirname, '..');
const SHOES_DIR = path.join(ROOT, 'shoes');
const DATA_FILE = path.join(ROOT, 'shoe-data.json');
const SITEMAP   = path.join(ROOT, 'sitemap.xml');

// ── HTTP fetch (follows redirects) ────────────────────────────────────────────
function fetch(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        resolve(fetch(res.headers.location, maxRedirects - 1));
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} from ${url}`)); return; }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ── CSV ───────────────────────────────────────────────────────────────────────
function splitCSVLine(line) {
  const out = []; let cur = '', inQ = false;
  for (const c of line) {
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const hdrs  = splitCSVLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = splitCSVLine(line);
    const obj  = {};
    hdrs.forEach((h, i) => {
      obj[h] = (vals[i] || '').trim();
      const lc = h.toLowerCase();
      if (!(lc in obj)) obj[lc] = (vals[i] || '').trim();
    });
    return obj;
  }).filter(r => r.brand && r.model);
}

function rowToShoe(r) {
  return {
    brand:        r.brand,
    model:        r.model,
    price:        r.price_gbp ? parseFloat(r.price_gbp) : 0,
    currency:     'GBP',
    fastening:    (r.fastening || '').trim(),
    asym:         r.asymmetry !== '' ? parseInt(r.asymmetry, 10) : null,
    downturn:     r.downturn  !== '' ? parseInt(r.downturn,  10) : null,
    heel:         r.heel      !== '' ? parseInt(r.heel,      10) : null,
    stiffness:    (r.stiffness || '').trim(),
    width:        r.width         ? r.width.split('|').map(s => s.trim())          : ['medium'],
    climbType:    r.climbing_types ? r.climbing_types.split('|').map(s => s.trim()) : [],
    rock_type:    (r.rock_type || '').trim(),
    footShape:    r.toe_shape ? r.toe_shape.trim().toLowerCase() : '',
    buyUrl:       (r.buy_url   || '').trim(),
    imageUrl:     (r.image_url || '').trim(),
    locations:    r.locations  ? r.locations.split('|').map(s => s.trim()) : [],
    vegan:        ['true','yes','y','1'].includes((r.vegan   || '').toLowerCase()),
    womens:       ['true','yes','y','1'].includes((r.Womens  || r.womens || '').toLowerCase()),
    resoleableRaw:(r.resoleable || '').trim().toLowerCase(),
    lining:       (r.lining     || '').trim(),
    sizingNote:   (r.sizing_note|| '').trim(),
  };
}

// ── Slugify ───────────────────────────────────────────────────────────────────
function slugify(brand, model) {
  return `${brand} ${model}`
    .toLowerCase()
    .replace(/\./g,  '-')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g,  '-')
    .replace(/^-|-$/g, '');
}

// ── Prose generation (no invented claims — derived purely from numeric fields) ─
function generateDescription(shoe) {
  const parts = [];

  // Aggression character
  const d = shoe.downturn, a = shoe.asym;
  if (d !== null && a !== null) {
    const avg = (d + a) / 2;
    if (avg < 0.5)      parts.push(`The ${shoe.model} is a flat, comfortable shoe built for all-day wear and longer routes.`);
    else if (avg < 1.3) parts.push(`The ${shoe.model} has moderate downturn and asymmetry, balancing technical precision with all-day comfort.`);
    else                parts.push(`The ${shoe.model} is an aggressively downturned shoe built for steep, technical climbing.`);
  } else {
    parts.push(`The ${shoe.brand} ${shoe.model} is a technical climbing shoe.`);
  }

  // Width + fastening
  const wStr = shoe.width.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('/');
  const fMap  = { velcro: 'velcro closures for quick transitions', lace: 'lace-up fastening for a fine-tuned fit', 'slip-on': 'slip-on design for effortless transitions' };
  const fNote = fMap[(shoe.fastening || '').toLowerCase()] || (shoe.fastening ? `${shoe.fastening} fastening` : '');

  if (wStr && fNote)       parts.push(`Available in ${wStr.toLowerCase()} fit with ${fNote}.`);
  else if (fNote)          parts.push(`Features ${fNote}.`);
  else if (wStr)           parts.push(`Available in ${wStr.toLowerCase()} fit.`);

  // Price + climbing type
  if (shoe.price) {
    const tMap  = { S: 'sport', B: 'bouldering', M: 'trad/multi-pitch' };
    const types = shoe.climbType.map(t => tMap[t]).filter(Boolean);
    const tStr  = types.length ? ` suited to ${types.join(' and ')} climbing` : '';
    parts.push(`Priced at £${shoe.price.toFixed(0)}${tStr}.`);
  }

  return parts.join(' ');
}

function generateMetaDesc(shoe) {
  const downMap = ['flat', 'moderate', 'aggressive'];
  const downStr = shoe.downturn !== null ? downMap[shoe.downturn] : null;
  const tMap    = { S: 'sport', B: 'bouldering', M: 'trad' };
  const types   = shoe.climbType.map(t => tMap[t]).filter(Boolean).join(' & ');
  const price   = shoe.price ? `£${shoe.price.toFixed(0)}` : null;

  const bits = [
    `${shoe.brand} ${shoe.model} climbing shoe`,
    downStr ? `${downStr} profile` : null,
    shoe.width.join('/') + ' fit',
    types  ? `for ${types}` : null,
    price  ? `from ${price}` : null,
  ].filter(Boolean);

  let d = bits.join(', ') + '. Specs, sizing notes, and where to buy.';
  if (d.length > 155) d = d.slice(0, 152) + '...';
  return d;
}

// ── Dot-row HTML (0–2 scale, matching index.html exactly) ────────────────────
function dotsHtml(val, max = 2) {
  if (val === null || val === undefined) return '<span class="no-data">—</span>';
  let d = '';
  for (let i = 0; i <= max; i++) d += `<span class="dot${i <= val ? ' filled' : ''}"></span>`;
  return `<span class="dot-row">${d}</span>`;
}

// ── Page template ─────────────────────────────────────────────────────────────
function buildPage(shoe, slug) {
  const title   = `${shoe.brand} ${shoe.model} Climbing Shoe — Specs, Price & Review | Rocksy Adventures`;
  const metaD   = generateMetaDesc(shoe);
  const desc    = generateDescription(shoe);
  const canonical = `${SITE_ROOT}/shoes/${slug}.html`;
  const ogImage   = shoe.imageUrl || `${SITE_ROOT}/shoes/images/NoImage.svg`;
  const buyUrl    = shoe.buyUrl ? shoe.buyUrl + UTM : '#';
  const hasLink   = !!shoe.buyUrl;

  const tMap    = { S: 'Sport', B: 'Bouldering', M: 'Trad / Multi-pitch' };
  const climbLabels = shoe.climbType.map(t => tMap[t] || t).filter(Boolean).join(', ');

  const resLabel = (['true','yes','y','1'].includes(shoe.resoleableRaw)) ? 'Yes'
                 : (['false','no','n','0'].includes(shoe.resoleableRaw)) ? 'No'
                 : shoe.resoleableRaw || '—';

  const specRows = [
    ['Fastening',   shoe.fastening ? capitalize(shoe.fastening) : null],
    ['Downturn',    shoe.downturn  !== null ? dotsHtml(shoe.downturn)  : null],
    ['Asymmetry',   shoe.asym      !== null ? dotsHtml(shoe.asym)      : null],
    ['Heel grip',   shoe.heel      !== null ? dotsHtml(shoe.heel)      : null],
    ['Width',       shoe.width.length ? shoe.width.map(capitalize).join(' / ') : null],
    ['Toe shape',   shoe.footShape ? capitalize(shoe.footShape) : null],
    ['Stiffness',   shoe.stiffness || null],
    ['Lining',      shoe.lining    || null],
    ['Climbing type', climbLabels  || null],
    ['Resoleable',  resLabel !== '—' ? resLabel : null],
  ].filter(([, v]) => v !== null);

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org/',
    '@type':    'Product',
    name:       `${shoe.brand} ${shoe.model} Climbing Shoe`,
    brand:      { '@type': 'Brand', name: shoe.brand },
    image:      ogImage,
    description: desc,
    ...(shoe.price && shoe.buyUrl ? {
      offers: {
        '@type':        'Offer',
        price:          shoe.price.toFixed(2),
        priceCurrency:  'GBP',
        url:            canonical,
        availability:   'https://schema.org/InStock',
      }
    } : {}),
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(metaD)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type"        content="product">
<meta property="og:title"       content="${esc(title)}">
<meta property="og:description" content="${esc(metaD)}">
<meta property="og:image"       content="${esc(ogImage)}">
<meta property="og:url"         content="${canonical}">
<meta name="twitter:card"        content="summary_large_image">
<meta name="twitter:title"       content="${esc(title)}">
<meta name="twitter:description" content="${esc(metaD)}">
<meta name="twitter:image"       content="${esc(ogImage)}">
<script type="application/ld+json">${jsonLd}</script>
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA4_ID}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${GA4_ID}');
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&family=Oswald:wght@500;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --moss:#2eada6;--moss-light:#3dbfb8;--moss-pale:#d6f2f0;
  --ink:#1a1a1a;--stone:#666;--pebble:#ddd;--warm:#f5f5f5;
}
body{font-family:'Nunito',sans-serif;color:var(--ink);background:#fff;line-height:1.6}
a{color:var(--moss);text-decoration:none}
a:hover{text-decoration:underline}

/* Header */
header{background:var(--moss);padding:0.9rem 1.5rem;display:flex;align-items:center;justify-content:space-between;gap:1rem}
.logo{font-family:'Oswald',sans-serif;font-size:1.4rem;font-weight:700;color:#fff;letter-spacing:0.5px;text-decoration:none}
.logo:hover{text-decoration:none;opacity:0.9}
.header-btn{background:rgba(255,255,255,0.18);color:#fff;border:1.5px solid rgba(255,255,255,0.4);border-radius:20px;padding:0.4rem 1rem;font-family:'Nunito',sans-serif;font-size:0.85rem;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block;transition:background 0.15s}
.header-btn:hover{background:rgba(255,255,255,0.3);text-decoration:none}

/* Breadcrumb */
.breadcrumb{max-width:860px;margin:1rem auto;padding:0 1.2rem;font-size:0.82rem;color:var(--stone)}
.breadcrumb a{color:var(--stone)}
.breadcrumb a:hover{color:var(--moss)}
.breadcrumb span{margin:0 0.4em}

/* Main layout */
main{max-width:860px;margin:0 auto;padding:2rem 1.2rem 4rem}

/* Shoe hero */
.shoe-hero{display:grid;grid-template-columns:minmax(200px,340px) 1fr;gap:2rem;align-items:start;margin-bottom:2.5rem}
@media(max-width:640px){.shoe-hero{grid-template-columns:1fr}}
.shoe-img-wrap{background:var(--warm);border-radius:14px;overflow:hidden;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center}
.shoe-img-wrap img{width:100%;height:100%;object-fit:contain;display:block}

.shoe-meta{}
.shoe-brand{font-size:0.88rem;font-weight:700;color:var(--moss);letter-spacing:0.5px;text-transform:uppercase;margin-bottom:0.3rem}
.shoe-name{font-family:'Oswald',sans-serif;font-size:2rem;font-weight:700;line-height:1.1;margin-bottom:0.6rem}
.shoe-price{font-size:1.5rem;font-weight:800;color:var(--ink);margin-bottom:1rem}
.shoe-price .currency{font-size:1rem;vertical-align:super;margin-right:1px}
.badge-row{display:flex;flex-wrap:wrap;gap:0.4rem;margin-bottom:1.2rem}
.badge{font-size:0.75rem;font-weight:700;padding:3px 10px;border-radius:20px;background:var(--moss-pale);color:var(--moss)}
.shoe-desc{font-size:0.95rem;color:#444;line-height:1.7;margin-bottom:1.5rem}

/* Action buttons */
.shoe-actions{display:flex;flex-wrap:wrap;gap:0.8rem;margin-bottom:0.6rem}
.btn-buy{display:inline-block;background:var(--moss);color:#fff;font-family:'Nunito',sans-serif;font-weight:800;font-size:1rem;padding:0.75rem 1.8rem;border-radius:50px;border:none;cursor:pointer;text-decoration:none;transition:background 0.15s,transform 0.1s}
.btn-buy:hover{background:var(--moss-light);text-decoration:none;transform:translateY(-1px)}
.btn-buy.no-stock{background:var(--pebble);color:var(--stone);cursor:default;pointer-events:none}
.btn-quiz{display:inline-block;border:2px solid var(--moss);color:var(--moss);font-family:'Nunito',sans-serif;font-weight:800;font-size:1rem;padding:0.72rem 1.6rem;border-radius:50px;text-decoration:none;transition:background 0.15s,color 0.15s}
.btn-quiz:hover{background:var(--moss);color:#fff;text-decoration:none}

/* Specs table */
.specs-section h2{font-family:'Oswald',sans-serif;font-size:1.3rem;font-weight:700;margin-bottom:1rem}
.specs-table{width:100%;border-collapse:collapse;font-size:0.92rem}
.specs-table tr{border-bottom:1px solid var(--pebble)}
.specs-table td{padding:0.6rem 0.4rem;vertical-align:middle}
.specs-table td:first-child{color:var(--stone);width:40%;font-weight:600}

/* Dot scale */
.dot-row{display:inline-flex;gap:4px;vertical-align:middle}
.dot{width:11px;height:11px;border-radius:50%;background:var(--pebble);display:inline-block}
.dot.filled{background:var(--moss)}
.no-data{color:var(--pebble)}

/* Sizing note */
.sizing-note{margin-top:0.5rem;font-size:0.82rem;color:var(--stone);background:var(--warm);border-radius:8px;padding:0.5rem 0.7rem}

/* CTA banner */
.cta-banner{background:var(--moss-pale);border:1.5px solid var(--moss);border-radius:14px;padding:1.5rem 2rem;text-align:center;margin-top:3rem}
.cta-banner p{font-size:1rem;color:var(--ink);margin-bottom:1rem;line-height:1.6}
.cta-banner strong{color:var(--moss)}

/* Footer */
footer{background:var(--moss);color:#fff;text-align:center;padding:1.5rem 1rem;font-size:0.85rem;margin-top:4rem}
footer a{color:rgba(255,255,255,0.8)}
footer a:hover{color:#fff}
</style>
</head>
<body>
<header>
  <a class="logo" href="/">Rocksy Adventures</a>
  <a class="header-btn" href="/">← Shoe Finder Quiz</a>
</header>

<div class="breadcrumb">
  <a href="/">Home</a><span>›</span><a href="/">Shoe Finder</a><span>›</span>${esc(shoe.brand)} ${esc(shoe.model)}
</div>

<main>
  <div class="shoe-hero">
    <div class="shoe-img-wrap">
      <img src="${shoe.imageUrl || 'images/NoImage.svg'}"
           alt="${esc(shoe.brand)} ${esc(shoe.model)}"
           onerror="this.onerror=null;this.src='images/NoImage.svg';">
    </div>
    <div class="shoe-meta">
      <p class="shoe-brand">${esc(shoe.brand)}</p>
      <h1 class="shoe-name">${esc(shoe.model)}</h1>
      <div class="shoe-price"><span class="currency">£</span>${shoe.price ? shoe.price.toFixed(0) : '—'}</div>
      <div class="badge-row">
        ${shoe.vegan  ? '<span class="badge">Vegan</span>' : ''}
        ${shoe.womens ? '<span class="badge">Women\'s fit</span>' : ''}
        ${climbLabels ? climbLabels.split(', ').map(l => `<span class="badge">${esc(l)}</span>`).join('') : ''}
      </div>
      <p class="shoe-desc">${esc(desc)}</p>
      <div class="shoe-actions">
        <a${hasLink ? ` href="${esc(buyUrl)}" target="_blank" rel="noopener noreferrer" onclick="gtag('event','buy_click',{shoe_brand:'${jsStr(shoe.brand)}',shoe_model:'${jsStr(shoe.model)}',outbound_url:'${jsStr(shoe.buyUrl)}'});"` : ''} class="btn-buy${hasLink ? '' : ' no-stock'}">${hasLink ? 'Buy now →' : 'Not yet available'}</a>
      </div>
      ${shoe.sizingNote ? `<div class="sizing-note">📏 ${esc(shoe.sizingNote)}</div>` : ''}
    </div>
  </div>

  <section class="specs-section">
    <h2>Specifications</h2>
    <table class="specs-table">
      <tbody>
${specRows.map(([k, v]) => `        <tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('\n')}
      </tbody>
    </table>
  </section>

  <div class="cta-banner">
    <p>Not sure if the <strong>${esc(shoe.brand)} ${esc(shoe.model)}</strong> is right for you?<br>
    Take our free 60-second quiz and get personalised recommendations based on your climbing style, foot shape, and budget.</p>
    <a href="/" class="btn-quiz"
       onclick="gtag('event','shoe_page_quiz_cta_click',{brand:'${jsStr(shoe.brand)}',model:'${jsStr(shoe.model)}'});">
      Find my perfect shoe →
    </a>
  </div>
</main>

<footer>
  <div>© Rocksy Adventures · <a href="/privacy.shtml">Privacy Policy</a></div>
</footer>
</body>
</html>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s)   { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function jsStr(s) { return String(s ?? '').replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// ── Sitemap ───────────────────────────────────────────────────────────────────
function buildSitemap(slugs) {
  const fixed = [
    `  <url><loc>${SITE_ROOT}/</loc><lastmod>${TODAY}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>`,
    `  <url><loc>${SITE_ROOT}/shoes/</loc><lastmod>${TODAY}</lastmod><changefreq>weekly</changefreq><priority>0.9</priority></url>`,
  ];
  const dynamic = slugs.map(slug =>
    `  <url><loc>${SITE_ROOT}/shoes/${slug}.html</loc><lastmod>${TODAY}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>`
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...fixed, ...dynamic].join('\n')}\n</urlset>\n`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Fetching shoe data from Google Sheets…');
  const csv = await fetch(SHEET_URL);
  const rows = parseCSV(csv);
  const shoeList = rows.map(rowToShoe);
  console.log(`  → ${shoeList.length} shoes found`);

  // Save shoe-data.json
  fs.writeFileSync(DATA_FILE, JSON.stringify(shoeList, null, 2));
  console.log(`Saved ${path.relative(ROOT, DATA_FILE)}`);

  // Generate pages
  const slugs = [];
  const seen  = new Set();
  let written = 0, skipped = 0;
  for (const shoe of shoeList) {
    let slug = slugify(shoe.brand, shoe.model);
    // Deduplicate slugs (shouldn't happen but guard anyway)
    if (seen.has(slug)) { let n = 2; while (seen.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}`; }
    seen.add(slug);
    slugs.push(slug);

    // Only write shoe pages — never overwrite index.html, proxy.php, etc.
    const outPath = path.join(SHOES_DIR, `${slug}.html`);
    const html = buildPage(shoe, slug);
    fs.writeFileSync(outPath, html);
    written++;
  }
  console.log(`Generated ${written} shoe pages in shoes/ (${skipped} skipped as duplicates)`);

  // Sitemap
  fs.writeFileSync(SITEMAP, buildSitemap(slugs));
  console.log(`Updated ${path.relative(ROOT, SITEMAP)}`);

  console.log('\nDone. Next steps:');
  console.log('  git add shoe-data.json shoes/ sitemap.xml');
  console.log('  git commit -m "Generate individual shoe pages + sitemap"');
}

main().catch(err => { console.error(err.message); process.exit(1); });
