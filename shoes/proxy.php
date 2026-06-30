<?php
// Secret key — must match PROXY_KEY in index.html
define('SECRET_KEY', 'd440719bc18135dd547592fb0aaa365a94baec13');

// Google Sheets CSV URL — server-side only, never sent to the browser
define('SHEET_URL', 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRmxyA2EDSWy23EqRbxYxdmM3IuHCL1Jg3sKgCx2Xle2RYfEZjN_60LCBbH1fl_7HVr_fboYQmOCBfE/pub?output=csv');

// Cache in server temp dir (not web-accessible)
define('CACHE_FILE', sys_get_temp_dir() . '/rocksy-shoes.csv');
define('CACHE_TTL', 300); // seconds — 5 minutes

// ── Validate secret key ───────────────────────────────────────────────────────
if (($_GET['k'] ?? '') !== SECRET_KEY) {
    http_response_code(403);
    exit;
}

// ── Validate Referer (stops casual use of the URL outside the site) ───────────
$referer = $_SERVER['HTTP_REFERER'] ?? '';
if ($referer !== '' && strpos($referer, 'rocksyadventures.com') === false) {
    http_response_code(403);
    exit;
}

// ── Serve from cache if still fresh ──────────────────────────────────────────
if (file_exists(CACHE_FILE) && (time() - filemtime(CACHE_FILE)) < CACHE_TTL) {
    header('Content-Type: text/csv; charset=utf-8');
    header('Cache-Control: no-store');
    readfile(CACHE_FILE);
    exit;
}

// ── Fetch fresh data from Google Sheets ──────────────────────────────────────
$csv = @file_get_contents(SHEET_URL);

if ($csv === false) {
    // Google unreachable — serve stale cache rather than breaking the site
    if (file_exists(CACHE_FILE)) {
        header('Content-Type: text/csv; charset=utf-8');
        header('Cache-Control: no-store');
        readfile(CACHE_FILE);
        exit;
    }
    http_response_code(502);
    exit;
}

// ── Write to cache and respond ────────────────────────────────────────────────
file_put_contents(CACHE_FILE, $csv);
header('Content-Type: text/csv; charset=utf-8');
header('Cache-Control: no-store');
echo $csv;
