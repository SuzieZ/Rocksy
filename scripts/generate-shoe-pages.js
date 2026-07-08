#!/usr/bin/env node
/**
 * Rocksy Adventures — Shoe Page Generator
 *
 * Fetches shoe data from Google Sheets, saves shoe-data.json,
 * generates one SEO-optimised HTML page per shoe to /shoes/{slug}.html,
 * and regenerates /sitemap.xml.
 *
 * Run from repo root:  node scripts/generate-shoe-pages.js
 * Idempotent: re-running regenerates cleanly from fresh data.
 */

'use strict';
const fs    = require('fs');
const path  = require('path');
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
    width:        r.width          ? r.width.split('|').map(s => s.trim())          : ['medium'],
    climbType:    r.climbing_types  ? r.climbing_types.split('|').map(s => { const w={'bouldering':'B','boulder':'B','sport':'S','trad':'M','multi-pitch':'M','multipitch':'M','board':'B'}; const t=s.trim().toLowerCase(); return w[t]||s.trim(); }) : [],
    rock_type:    (r.rock_type || '').trim(),
    footShape:    r.toe_shape ? r.toe_shape.trim().toLowerCase() : '',
    buyUrl:       (r.buy_url    || '').trim(),
    imageUrl:     (r.image_url  || '').trim(),
    locations:    r.locations   ? r.locations.split('|').map(s => s.trim()) : [],
    vegan:        ['true','yes','y','1'].includes((r.vegan  || '').toLowerCase()),
    womens:       ['true','yes','y','1'].includes((r.Womens || r.womens || '').toLowerCase()),
    resoleableRaw:(r.resoleable  || '').trim().toLowerCase(),
    lining:       (r.lining      || '').trim(),
    sizingNote:   (r.sizing_note || '').trim(),
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

// ── Derived attributes ────────────────────────────────────────────────────────
function aggrLevel(shoe) {
  // Returns 'flat' | 'moderate' | 'aggressive' | null
  const d = shoe.downturn, a = shoe.asym;
  if (d === null && a === null) return null;
  const avg = ((d ?? 1) + (a ?? 1)) / 2;
  if (avg < 0.75) return 'flat';
  if (avg < 1.4)  return 'moderate';
  return 'aggressive';
}

function climbTypeLabels(shoe) {
  const map = { S: 'sport', B: 'bouldering', M: 'trad/multi-pitch' };
  return shoe.climbType.map(t => map[t]).filter(Boolean);
}

function rockTypeList(shoe) {
  return shoe.rock_type ? shoe.rock_type.split('|').map(s => s.trim()).filter(Boolean) : [];
}

function resoleLabel(shoe) {
  if (['true','yes','y','1'].includes(shoe.resoleableRaw)) return 'Yes';
  if (['false','no','n','0'].includes(shoe.resoleableRaw)) return 'No';
  return shoe.resoleableRaw || null;
}

function footShapeKeywords(shape) {
  const map = {
    pointed:   'pointed (Egyptian) toe shape',
    tapered:   'tapered toe shape',
    round:     'round (Greek) toe shape',
    square:    'square (Roman) toe shape',
  };
  return map[shape] || `${shape} toe shape`;
}

// ── Title (55–60 chars target) ────────────────────────────────────────────────
function buildTitle(shoe) {
  const aggr  = aggrLevel(shoe);
  const types = climbTypeLabels(shoe);
  // Build a short attribute qualifier
  let qualifier = '';
  if (aggr === 'aggressive' && types.includes('bouldering')) qualifier = 'Aggressive Bouldering Shoe';
  else if (aggr === 'aggressive' && types.includes('sport'))  qualifier = 'Aggressive Sport Climbing Shoe';
  else if (aggr === 'aggressive')                             qualifier = 'Aggressive Climbing Shoe';
  else if (aggr === 'flat' && types.includes('trad/multi-pitch')) qualifier = 'Trad Climbing Shoe';
  else if (aggr === 'flat')                                   qualifier = 'Beginner-Friendly Climbing Shoe';
  else if (types.length)                                      qualifier = `${cap(types[0])} Climbing Shoe`;
  else                                                        qualifier = 'Climbing Shoe';
  return `${shoe.brand} ${shoe.model} Review — ${qualifier} | Rocksy Adventures`;
}

// ── Meta description (~155 chars) ────────────────────────────────────────────
function buildMetaDesc(shoe) {
  const aggr   = aggrLevel(shoe);
  const types  = climbTypeLabels(shoe);
  const wStr   = shoe.width.join('/');
  const price  = shoe.price ? `£${shoe.price.toFixed(0)}` : null;
  const shape  = shoe.footShape ? `${shoe.footShape} toe` : null;

  const bits = [
    `${shoe.brand} ${shoe.model}`,
    aggr   ? `${aggr} profile`   : null,
    wStr   ? `${wStr} fit`       : null,
    shape,
    types.length ? `for ${types.join(' & ')}` : null,
    price  ? `from ${price}`     : null,
  ].filter(Boolean);

  let d = bits.join(', ') + '. Read the full spec breakdown, sizing advice, and where to buy.';
  if (d.length > 155) d = d.slice(0, 152) + '...';
  return d;
}

// ── FAQ generation ────────────────────────────────────────────────────────────
function buildFAQs(shoe) {
  const faqs = [];
  const aggr  = aggrLevel(shoe);
  const types = climbTypeLabels(shoe);
  const rocks = rockTypeList(shoe);
  const widths = shoe.width;

  // Q: climbing styles
  if (types.length) {
    faqs.push({
      q: `What climbing styles is the ${shoe.brand} ${shoe.model} designed for?`,
      a: `The ${shoe.model} is designed primarily for ${types.join(' and ')} climbing.` +
         (rocks.length ? ` It performs particularly well on ${rocks.join(', ')}.` : ''),
    });
  }

  // Q: beginner suitability
  if (aggr) {
    const begs = { flat: true, moderate: false, aggressive: false }[aggr];
    faqs.push({
      q: `Is the ${shoe.brand} ${shoe.model} suitable for beginners?`,
      a: begs
        ? `Yes. The ${shoe.model} has a flat, relaxed profile — it prioritises comfort and is well-suited to beginners, gym climbers, and anyone spending long sessions on the wall.`
        : aggr === 'aggressive'
          ? `No. The ${shoe.model} has an aggressive downturn and asymmetric shape that requires precise footwork to use effectively. It is intended for intermediate to advanced climbers.`
          : `The ${shoe.model} has a moderate profile that suits intermediate climbers. It is usable by confident beginners but will feel most natural to someone past their first year of climbing.`,
    });
  }

  // Q: wide/narrow fit
  if (widths.length) {
    const hasWide   = widths.includes('wide');
    const hasNarrow = widths.includes('narrow');
    const hasMedium = widths.includes('medium');
    if (hasWide || hasNarrow) {
      const fits = [];
      if (hasNarrow) fits.push('narrow');
      if (hasMedium) fits.push('medium');
      if (hasWide)   fits.push('wide');
      faqs.push({
        q: `Does the ${shoe.brand} ${shoe.model} fit wide feet?`,
        a: hasWide
          ? `Yes. The ${shoe.model} is available in ${fits.join(', ')} widths and is specifically made to accommodate wider feet.`
          : `The ${shoe.model} is available in ${fits.join(', ')} width${fits.length > 1 ? 's' : ''} only. Climbers with wide feet may find it a poor fit and should try it on before buying.`,
      });
    }
  }

  // Q: toe shape
  if (shoe.footShape) {
    const shapeMap = {
      pointed: 'a pointed (Egyptian) foot — where the big toe is longest',
      tapered: 'a tapered foot — where toes taper evenly from big to little',
      round:   'a round (Greek) foot — where the second toe is equal in length to the big toe',
      square:  'a square (Roman) foot — where the first two or three toes are approximately equal in length',
    };
    const shapeDesc = shapeMap[shoe.footShape] || `a ${shoe.footShape} foot shape`;
    faqs.push({
      q: `What toe shape does the ${shoe.brand} ${shoe.model} suit?`,
      a: `The ${shoe.model} is shaped for climbers with ${shapeDesc}. If your toes don't match this profile, you may find the fit uncomfortable at the toe box.`,
    });
  }

  // Q: resoleable
  const resole = resoleLabel(shoe);
  if (resole) {
    faqs.push({
      q: `Can the ${shoe.brand} ${shoe.model} be resoled?`,
      a: resole === 'Yes'
        ? `Yes. The ${shoe.model} can be resoled, which significantly extends the shoe's lifespan and reduces long-term cost. Most climbing shoe repair specialists offer resoling from around £35–£55.`
        : `No. The ${shoe.model} is not designed to be resoled. Once the rubber wears through, you'll need a new pair.`,
    });
  }

  // Q: vegan
  if (shoe.vegan) {
    faqs.push({
      q: `Is the ${shoe.brand} ${shoe.model} vegan?`,
      a: `Yes. The ${shoe.model} is made without any animal-derived materials and is suitable for vegan climbers.`,
    });
  }

  // Q: sizing
  if (shoe.sizingNote) {
    faqs.push({
      q: `How should I size the ${shoe.brand} ${shoe.model}?`,
      a: shoe.sizingNote,
    });
  }

  // Q: rock type / terrain
  if (rocks.length > 1) {
    faqs.push({
      q: `What rock types is the ${shoe.brand} ${shoe.model} best suited to?`,
      a: `The ${shoe.model} performs best on ${rocks.join(', ')}. Its rubber compound and profile are optimised for these surfaces.`,
    });
  }

  // Q: women's specific
  if (shoe.womens) {
    faqs.push({
      q: `Is the ${shoe.brand} ${shoe.model} a women's specific shoe?`,
      a: `Yes. The ${shoe.model} is a women's specific shoe with a last designed for a typically narrower heel and lower-volume foot shape.`,
    });
  }

  return faqs;
}

// ── "Who is this for?" copy ───────────────────────────────────────────────────
function buildWhoFor(shoe) {
  const aggr  = aggrLevel(shoe);
  const types = climbTypeLabels(shoe);
  const rocks = rockTypeList(shoe);

  const experienceMap = {
    flat:       'beginners and recreational climbers',
    moderate:   'intermediate climbers',
    aggressive: 'experienced and advanced climbers',
  };
  const experience = aggr ? experienceMap[aggr] : 'a wide range of climbers';

  const typeStr = types.length
    ? (types.length === 1 ? types[0] : types.slice(0,-1).join(', ') + ' and ' + types[types.length-1])
    : null;

  const rockStr = rocks.length ? rocks.join(', ') : null;

  const widthStr = shoe.width.includes('wide')
    ? ' It has a wider last that suits climbers who struggle to fit into standard shoes.'
    : shoe.width.includes('narrow')
    ? ' It has a narrow last designed for climbers with a slim foot profile.'
    : '';

  const shapeStr = shoe.footShape
    ? ` The toe box suits a ${footShapeKeywords(shoe.footShape)}.`
    : '';

  let who = `The ${shoe.brand} ${shoe.model} is built for ${experience}`;
  if (typeStr) who += ` who focus on ${typeStr}`;
  if (rockStr) who += `, particularly on ${rockStr}`;
  who += `.${widthStr}${shapeStr}`;

  return who;
}

// ── Full description (3–4 sentences) ─────────────────────────────────────────
function buildDescription(shoe) {
  const aggr  = aggrLevel(shoe);
  const types = climbTypeLabels(shoe);
  const parts = [];

  // Sentence 1: character
  const aggrSentences = {
    flat:       `The ${shoe.model} is a flat, relaxed shoe built for comfort on longer routes and all-day wear.`,
    moderate:   `The ${shoe.model} has a moderate profile — enough downturn and asymmetry for technical footwork, without sacrificing all-day comfort.`,
    aggressive: `The ${shoe.model} is an aggressively downturned shoe built for steep overhanging terrain, with a highly asymmetric shape that channels power to the toe.`,
  };
  parts.push(aggr ? aggrSentences[aggr] : `The ${shoe.brand} ${shoe.model} is a technical climbing shoe.`);

  // Sentence 2: width + fastening
  const wStr = shoe.width.map(cap).join('/');
  const fMap = {
    velcro:    'velcro closures for fast on-off transitions',
    lace:      'traditional lace-up fastening for a completely customisable fit',
    'slip-on': 'a slip-on design that wraps the foot without any closures',
  };
  const fNote = fMap[(shoe.fastening || '').toLowerCase()] || (shoe.fastening ? `${shoe.fastening} fastening` : '');
  if (wStr && fNote)  parts.push(`It offers a ${wStr.toLowerCase()} fit and uses ${fNote}.`);
  else if (fNote)     parts.push(`It uses ${fNote}.`);
  else if (wStr)      parts.push(`Available in ${wStr.toLowerCase()} fit.`);

  // Sentence 3: climbing type + price
  if (shoe.price) {
    const typeStr = types.length ? ` suited to ${types.join(' and ')} climbing` : '';
    parts.push(`Priced at £${shoe.price.toFixed(0)}, it is a performance option${typeStr}.`);
  }

  // Sentence 4: extras
  const extras = [];
  if (shoe.vegan)   extras.push('constructed without animal-derived materials');
  if (resoleLabel(shoe) === 'Yes') extras.push('resoleable for an extended lifespan');
  if (shoe.womens)  extras.push("made on a women's-specific last");
  if (extras.length) parts.push(`The ${shoe.model} is ${extras.join(' and ')}.`);

  return parts.join(' ');
}

// ── Dot-row HTML ──────────────────────────────────────────────────────────────
function dotsHtml(val, max = 2) {
  if (val === null || val === undefined) return '<span class="no-data">—</span>';
  const labels = ['Low', 'Medium', 'High'];
  let d = '';
  for (let i = 0; i <= max; i++) d += `<span class="dot${i <= val ? ' filled' : ''}"></span>`;
  return `<span class="dot-row" title="${labels[val] || val}/2">${d}</span> <span class="dot-label">${labels[val] || ''}</span>`;
}

// ── Page template ─────────────────────────────────────────────────────────────
function buildPage(shoe, slug) {
  const title     = buildTitle(shoe);
  const metaD     = buildMetaDesc(shoe);
  const canonical = `${SITE_ROOT}/shoes/${slug}.html`;
  const ogImage   = shoe.imageUrl || `${SITE_ROOT}/shoes/images/NoImage.svg`;
  const buyUrl    = shoe.buyUrl ? shoe.buyUrl + UTM : '#';
  const hasLink   = !!shoe.buyUrl;
  const faqs      = buildFAQs(shoe);
  const whoFor    = buildWhoFor(shoe);
  const desc      = buildDescription(shoe);
  const types     = climbTypeLabels(shoe);
  const rocks     = rockTypeList(shoe);
  const aggr      = aggrLevel(shoe);
  const resole    = resoleLabel(shoe);

  const tFullMap  = { S: 'Sport', B: 'Bouldering', M: 'Trad / Multi-pitch' };
  const climbLabels = shoe.climbType.map(t => tFullMap[t] || t).filter(Boolean);

  // Specs table rows (label + value; skip nulls)
  const specRows = [
    ['Fastening',     shoe.fastening ? cap(shoe.fastening) : null],
    ['Downturn',      shoe.downturn  !== null ? dotsHtml(shoe.downturn)  : null],
    ['Asymmetry',     shoe.asym      !== null ? dotsHtml(shoe.asym)      : null],
    ['Heel grip',     shoe.heel      !== null ? dotsHtml(shoe.heel)      : null],
    ['Width',         shoe.width.length ? shoe.width.map(cap).join(' / ') : null],
    ['Toe shape',     shoe.footShape ? `${cap(shoe.footShape)}${shoe.footShape === 'pointed' ? ' (Egyptian)' : shoe.footShape === 'round' ? ' (Greek)' : shoe.footShape === 'square' ? ' (Roman)' : ''}` : null],
    ['Climbing type', climbLabels.join(', ') || null],
    ['Rock type',     rocks.join(', ') || null],
    ['Stiffness',     shoe.stiffness || null],
    ['Lining',        shoe.lining    || null],
    ['Resoleable',    resole],
    ['Vegan',         shoe.vegan ? 'Yes' : null],
  ].filter(([, v]) => v !== null);

  // Schema.org — Product
  const productSchema = {
    '@context':  'https://schema.org/',
    '@type':     'Product',
    name:        `${shoe.brand} ${shoe.model} Climbing Shoe`,
    brand:       { '@type': 'Brand', name: shoe.brand },
    image:       ogImage,
    description: desc,
    ...(shoe.price && shoe.buyUrl ? {
      offers: {
        '@type':       'Offer',
        price:         shoe.price.toFixed(2),
        priceCurrency: 'GBP',
        url:           canonical,
        availability:  'https://schema.org/InStock',
      },
    } : {}),
  };

  // Schema.org — BreadcrumbList
  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type':    'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_ROOT + '/' },
      { '@type': 'ListItem', position: 2, name: 'Shoe Finder', item: SITE_ROOT + '/shoes/' },
      { '@type': 'ListItem', position: 3, name: `${shoe.brand} ${shoe.model}`, item: canonical },
    ],
  };

  // Schema.org — FAQPage
  const faqSchema = faqs.length ? {
    '@context': 'https://schema.org',
    '@type':    'FAQPage',
    mainEntity: faqs.map(f => ({
      '@type':          'Question',
      name:             f.q,
      acceptedAnswer:   { '@type': 'Answer', text: f.a },
    })),
  } : null;

  const faqHtml = faqs.length ? `
  <section class="faq-section" id="faq">
    <h2>Frequently Asked Questions</h2>
    ${faqs.map(f => `
    <div class="faq-item">
      <h3>${esc(f.q)}</h3>
      <p>${esc(f.a)}</p>
    </div>`).join('')}
  </section>` : '';

  // Badge row
  const badges = [
    ...climbLabels.map(l => `<span class="badge">${esc(l)}</span>`),
    aggr ? `<span class="badge badge-aggr">${cap(aggr)}</span>` : '',
    shoe.vegan  ? '<span class="badge badge-green">Vegan</span>' : '',
    shoe.womens ? "<span class=\"badge\">Women's</span>" : '',
  ].filter(Boolean).join('');

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
<script type="application/ld+json">${JSON.stringify(productSchema)}</script>
<script type="application/ld+json">${JSON.stringify(breadcrumbSchema)}</script>
${faqSchema ? `<script type="application/ld+json">${JSON.stringify(faqSchema)}</script>` : ''}
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA4_ID}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA4_ID}');</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&family=Oswald:wght@500;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--moss:#2eada6;--moss-light:#3dbfb8;--moss-pale:#d6f2f0;--ink:#1a1a1a;--stone:#666;--pebble:#ddd;--warm:#f5f5f5}
body{font-family:'Nunito',sans-serif;color:var(--ink);background:#fff;line-height:1.6}
a{color:var(--moss);text-decoration:none}a:hover{text-decoration:underline}
h2{font-family:'Oswald',sans-serif;font-size:1.4rem;font-weight:700;margin:2.5rem 0 1rem}
h3{font-size:1rem;font-weight:700;margin-bottom:0.35rem}
p{margin-bottom:0.8rem}
/* Header */
header{background:var(--moss);padding:0.9rem 1.5rem;display:flex;align-items:center;justify-content:space-between;gap:1rem}
.logo{font-family:'Oswald',sans-serif;font-size:1.4rem;font-weight:700;color:#fff;letter-spacing:0.5px;text-decoration:none}
.logo:hover{text-decoration:none;opacity:0.9}
.header-btn{background:rgba(255,255,255,0.18);color:#fff;border:1.5px solid rgba(255,255,255,0.4);border-radius:20px;padding:0.4rem 1rem;font-family:'Nunito',sans-serif;font-size:0.85rem;font-weight:700;cursor:pointer;text-decoration:none;transition:background 0.15s}
.header-btn:hover{background:rgba(255,255,255,0.3);text-decoration:none}
/* Breadcrumb */
.breadcrumb{max-width:900px;margin:1rem auto;padding:0 1.2rem;font-size:0.82rem;color:var(--stone)}
.breadcrumb a{color:var(--stone)}.breadcrumb a:hover{color:var(--moss)}.breadcrumb span{margin:0 0.4em}
/* Main */
main{max-width:900px;margin:0 auto;padding:2rem 1.2rem 4rem}
/* Hero grid */
.shoe-hero{display:grid;grid-template-columns:minmax(200px,360px) 1fr;gap:2.5rem;align-items:start;margin-bottom:2.5rem}
@media(max-width:640px){.shoe-hero{grid-template-columns:1fr}}
.shoe-img-wrap{background:var(--warm);border-radius:14px;overflow:hidden;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center}
.shoe-img-wrap img{width:100%;height:100%;object-fit:contain;display:block}
/* Meta */
.shoe-brand-label{font-size:0.82rem;font-weight:800;color:var(--moss);letter-spacing:1px;text-transform:uppercase;margin-bottom:0.3rem}
.shoe-h1{font-family:'Oswald',sans-serif;font-size:2.1rem;font-weight:700;line-height:1.1;margin-bottom:0.6rem}
.shoe-price{font-size:1.6rem;font-weight:800;margin-bottom:0.9rem}
.shoe-price .cur{font-size:1rem;vertical-align:super;margin-right:1px}
.badge-row{display:flex;flex-wrap:wrap;gap:0.4rem;margin-bottom:1.2rem}
.badge{font-size:0.75rem;font-weight:700;padding:3px 10px;border-radius:20px;background:var(--moss-pale);color:var(--moss)}
.badge-aggr{background:#fef3e2;color:#b45309}
.badge-green{background:#dcfce7;color:#166534}
.shoe-desc-lead{font-size:1rem;color:#333;line-height:1.75;margin-bottom:1.5rem}
/* Who for */
.who-for{background:var(--moss-pale);border-left:4px solid var(--moss);border-radius:0 10px 10px 0;padding:0.9rem 1.2rem;margin-bottom:1.5rem;font-size:0.95rem;color:var(--ink)}
/* Actions */
.shoe-actions{display:flex;flex-wrap:wrap;gap:0.8rem}
.btn-buy{display:inline-block;background:var(--moss);color:#fff;font-family:'Nunito',sans-serif;font-weight:800;font-size:1rem;padding:0.75rem 1.8rem;border-radius:50px;border:none;cursor:pointer;text-decoration:none;transition:background 0.15s,transform 0.1s}
.btn-buy:hover{background:var(--moss-light);text-decoration:none;transform:translateY(-1px)}
.btn-buy.no-stock{background:var(--pebble);color:var(--stone);cursor:default;pointer-events:none}
/* Sizing note */
.sizing-note-box{background:var(--warm);border-radius:10px;padding:0.7rem 1rem;font-size:0.88rem;color:#444;margin-top:1.5rem}
.sizing-note-box strong{color:var(--ink)}
/* Specs */
.specs-table{width:100%;border-collapse:collapse;font-size:0.93rem}
.specs-table tr{border-bottom:1px solid var(--pebble)}
.specs-table tr:last-child{border-bottom:none}
.specs-table td{padding:0.65rem 0.4rem;vertical-align:middle}
.specs-table td:first-child{color:var(--stone);width:38%;font-weight:700;font-size:0.85rem;text-transform:uppercase;letter-spacing:0.5px}
.dot-row{display:inline-flex;gap:4px;vertical-align:middle}
.dot{width:11px;height:11px;border-radius:50%;background:var(--pebble);display:inline-block}
.dot.filled{background:var(--moss)}
.dot-label{font-size:0.8rem;color:var(--stone);margin-left:6px}
.no-data{color:var(--pebble)}
/* FAQs */
.faq-section .faq-item{border-bottom:1px solid var(--pebble);padding:1rem 0}
.faq-section .faq-item:last-child{border-bottom:none}
.faq-section h3{font-size:0.97rem;font-weight:700;color:var(--ink);margin-bottom:0.4rem}
.faq-section p{font-size:0.92rem;color:#444;line-height:1.65;margin:0}
/* CTA */
.cta-banner{background:var(--moss-pale);border:1.5px solid var(--moss);border-radius:14px;padding:2rem;text-align:center;margin-top:3rem}
.cta-banner h2{margin:0 0 0.6rem;font-size:1.3rem}
.cta-banner p{font-size:0.97rem;color:#333;margin-bottom:1.3rem}
.btn-quiz{display:inline-block;background:var(--moss);color:#fff;font-family:'Nunito',sans-serif;font-weight:800;font-size:1rem;padding:0.8rem 2rem;border-radius:50px;text-decoration:none;transition:background 0.15s,transform 0.1s}
.btn-quiz:hover{background:var(--moss-light);text-decoration:none;transform:translateY(-1px)}
/* Footer */
footer{background:var(--moss);color:#fff;text-align:center;padding:1.5rem 1rem;font-size:0.85rem;margin-top:4rem}
footer a{color:rgba(255,255,255,0.8)}footer a:hover{color:#fff}
</style>
</head>
<body>
<header>
  <a class="logo" href="/">Rocksy Adventures</a>
  <a class="header-btn" href="/">← Shoe Finder Quiz</a>
</header>

<nav class="breadcrumb" aria-label="Breadcrumb">
  <a href="/">Home</a><span aria-hidden="true">›</span>
  <a href="/">Shoe Finder</a><span aria-hidden="true">›</span>
  <span>${esc(shoe.brand)} ${esc(shoe.model)}</span>
</nav>

<main>
  <div class="shoe-hero">
    <div class="shoe-img-wrap">
      <img src="${shoe.imageUrl || 'images/NoImage.svg'}"
           alt="${esc(shoe.brand)} ${esc(shoe.model)} climbing shoe"
           width="360" height="270"
           onerror="this.onerror=null;this.src='images/NoImage.svg';">
    </div>

    <div class="shoe-meta">
      <p class="shoe-brand-label">${esc(shoe.brand)}</p>
      <h1 class="shoe-h1">${esc(shoe.model)}</h1>
      ${shoe.price ? `<div class="shoe-price"><span class="cur">£</span>${shoe.price.toFixed(0)}</div>` : ''}
      <div class="badge-row">${badges}</div>

      <p class="shoe-desc-lead">${esc(desc)}</p>

      <div class="who-for">
        <strong>Best for:</strong> ${esc(whoFor)}
      </div>

      <div class="shoe-actions">
        <a${hasLink
            ? ` href="${esc(buyUrl)}" target="_blank" rel="noopener noreferrer" onclick="gtag('event','buy_click',{shoe_brand:'${jsStr(shoe.brand)}',shoe_model:'${jsStr(shoe.model)}',outbound_url:'${jsStr(shoe.buyUrl)}'});"`
            : ''}
           class="btn-buy${hasLink ? '' : ' no-stock'}">${hasLink ? 'Buy now →' : 'Not yet available'}</a>
      </div>

      ${shoe.sizingNote ? `<div class="sizing-note-box"><strong>Sizing note:</strong> ${esc(shoe.sizingNote)}</div>` : ''}
    </div>
  </div>

  <section id="specs">
    <h2>${esc(shoe.brand)} ${esc(shoe.model)} — Full Specifications</h2>
    <table class="specs-table">
      <tbody>
${specRows.map(([k, v]) => `        <tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('\n')}
      </tbody>
    </table>
  </section>

  ${faqHtml}

  <div class="cta-banner">
    <h2>Not sure if this is the right shoe?</h2>
    <p>Answer 6 quick questions and get personalised climbing shoe recommendations based on your experience, climbing style, foot shape, and budget.</p>
    <a href="/"
       class="btn-quiz"
       onclick="gtag('event','shoe_page_quiz_cta_click',{brand:'${jsStr(shoe.brand)}',model:'${jsStr(shoe.model)}'});">
      Take the free 60-second quiz →
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
function cap(s)   { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// ── Sitemap ───────────────────────────────────────────────────────────────────
function buildSitemap(slugs) {
  const fixed = [
    `  <url><loc>${SITE_ROOT}/</loc><lastmod>${TODAY}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>`,
    `  <url><loc>${SITE_ROOT}/shoes/</loc><lastmod>${TODAY}</lastmod><changefreq>weekly</changefreq><priority>0.9</priority></url>`,
  ];
  const dynamic = slugs.map(slug =>
    `  <url><loc>${SITE_ROOT}/shoes/${slug}.html</loc><lastmod>${TODAY}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>`
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Auto-generated by scripts/generate-shoe-pages.js — do not edit by hand -->\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...fixed, ...dynamic].join('\n')}\n</urlset>\n`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Fetching shoe data from Google Sheets…');
  const csv = await fetch(SHEET_URL);
  const rows = parseCSV(csv);
  const shoeList = rows.map(rowToShoe);
  console.log(`  → ${shoeList.length} shoes found`);

  fs.writeFileSync(DATA_FILE, JSON.stringify(shoeList, null, 2));
  console.log(`Saved ${path.relative(ROOT, DATA_FILE)}`);

  const slugs = [];
  const seen  = new Set();
  let written = 0;
  for (const shoe of shoeList) {
    let slug = slugify(shoe.brand, shoe.model);
    if (seen.has(slug)) { let n = 2; while (seen.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}`; }
    seen.add(slug);
    slugs.push(slug);
    fs.writeFileSync(path.join(SHOES_DIR, `${slug}.html`), buildPage(shoe, slug));
    written++;
  }
  console.log(`Generated ${written} shoe pages in shoes/`);

  fs.writeFileSync(SITEMAP, buildSitemap(slugs));
  console.log(`Updated ${path.relative(ROOT, SITEMAP)}`);

  console.log('\nDone. Next steps:');
  console.log('  git add shoe-data.json shoes/ sitemap.xml');
  console.log('  git commit -m "Generate individual shoe pages + sitemap"');
}

main().catch(err => { console.error(err.message); process.exit(1); });
