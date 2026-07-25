'use strict';
window.rocksyCurrency = (async function () {
  const GBP_TZ   = new Set(['Europe/London','Europe/Belfast','Europe/Isle_of_Man','Europe/Jersey','Europe/Guernsey']);
  const EUR_EXTRA = new Set(['Atlantic/Azores','Atlantic/Canary','Atlantic/Faroe','Atlantic/Madeira']);
  const SYM = { GBP: '£', EUR: '€', USD: '$' };

  const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone || '');
  const currency = GBP_TZ.has(tz) ? 'GBP'
    : (tz.startsWith('Europe/') || EUR_EXTRA.has(tz)) ? 'EUR'
    : 'USD';

  let rates = { GBP: 1, EUR: 1.18, USD: 1.27 };
  try {
    const KEY = 'rocksy_fx_v1';
    const cached = sessionStorage.getItem(KEY);
    if (cached) {
      rates = JSON.parse(cached);
    } else {
      const r = await fetch('https://api.frankfurter.app/latest?base=GBP&symbols=EUR,USD');
      if (r.ok) {
        const d = await r.json();
        rates = { GBP: 1, EUR: d.rates.EUR, USD: d.rates.USD };
        sessionStorage.setItem(KEY, JSON.stringify(rates));
      }
    }
  } catch (_) {}

  function fmtPrice(gbp, eur, usd) {
    const sym   = SYM[currency];
    const exact = { GBP: gbp, EUR: eur, USD: usd }[currency];
    if (exact > 0) return sym + Math.round(exact);
    const baseGBP = gbp > 0 ? gbp
      : eur > 0 ? eur / rates.EUR
      : usd > 0 ? usd / rates.USD
      : 0;
    if (!baseGBP) return null;
    return '~' + sym + Math.round(currency === 'GBP' ? baseGBP : baseGBP * rates[currency]);
  }

  // Auto-apply on static generated shoe pages
  document.querySelectorAll('[data-price-gbp]').forEach(el => {
    const fmt = fmtPrice(
      parseFloat(el.dataset.priceGbp) || 0,
      parseFloat(el.dataset.priceEur) || 0,
      parseFloat(el.dataset.priceUsd) || 0
    );
    if (fmt !== null) el.textContent = fmt;
  });

  return { currency, rates, fmtPrice, SYM };
})();
