/* EdgePilot - util.js
 * Namespace, formatting, sanitizing, time/session helpers.
 * DOM-free where possible so this file can be importScripts()'d by a worker.
 */
(function (root) {
  'use strict';
  var EP = root.EP = root.EP || {};

  /* ---------------------------------------------------------------
   * APP VERSION - the single source of truth.
   *
   * Bump this on every change you ship. The service worker reads it to
   * name its cache, so without a bump users keep running the old files
   * no matter what you push to Pages.
   *
   *   patch  1.1.0 -> 1.1.1   bug fix, wording, styling
   *   minor  1.1.0 -> 1.2.0   new feature or screen
   *   major  1.1.0 -> 2.0.0   engine or scoring change that makes old
   *                           resolved signals no longer comparable
   * --------------------------------------------------------------- */
  EP.VERSION = '1.1.0';
  EP.BUILT = '2026-08-19';

  var U = EP.util = {};

  /* ---------- instruments ---------- */

  U.INSTRUMENTS = [
    { id: 'XAU/USD', label: 'XAU/USD', kind: 'metal',  digits: 2, pip: 0.1,     pointValuePerLot: 100,    defaultSpread: 0.25,   optional: false },
    { id: 'EUR/USD', label: 'EUR/USD', kind: 'fx',     digits: 5, pip: 0.0001,  pointValuePerLot: 100000, defaultSpread: 0.00012, optional: false },
    { id: 'GBP/USD', label: 'GBP/USD', kind: 'fx',     digits: 5, pip: 0.0001,  pointValuePerLot: 100000, defaultSpread: 0.00016, optional: false },
    { id: 'USD/JPY', label: 'USD/JPY', kind: 'fx_jpy', digits: 3, pip: 0.01,    pointValuePerLot: 100000, defaultSpread: 0.014,  optional: false, quoteIsUsd: false },
    { id: 'USD/CHF', label: 'USD/CHF', kind: 'fx',     digits: 5, pip: 0.0001,  pointValuePerLot: 100000, defaultSpread: 0.00018, optional: false, quoteIsUsd: false },
    { id: 'AUD/USD', label: 'AUD/USD', kind: 'fx',     digits: 5, pip: 0.0001,  pointValuePerLot: 100000, defaultSpread: 0.00015, optional: false },
    { id: 'USD/CAD', label: 'USD/CAD', kind: 'fx',     digits: 5, pip: 0.0001,  pointValuePerLot: 100000, defaultSpread: 0.00018, optional: false, quoteIsUsd: false },
    { id: 'BTC/USD', label: 'BTC/USD', kind: 'crypto', digits: 2, pip: 1,       pointValuePerLot: 1,      defaultSpread: 18,     optional: true }
  ];

  U.instrument = function (id) {
    for (var i = 0; i < U.INSTRUMENTS.length; i++) if (U.INSTRUMENTS[i].id === id) return U.INSTRUMENTS[i];
    return null;
  };

  /* ---------- timeframes ---------- */

  U.TF_MS = {
    '15min': 15 * 60000,
    '1h': 60 * 60000,
    '4h': 4 * 60 * 60000,
    '1day': 24 * 60 * 60000
  };
  U.TF_LABEL = { '15min': 'M15', '1h': 'H1', '4h': 'H4', '1day': 'D1' };

  /* ---------- numbers ---------- */

  U.isNum = function (n) { return typeof n === 'number' && isFinite(n); };

  U.round = function (n, d) {
    if (!U.isNum(n)) return null;
    var f = Math.pow(10, d || 0);
    return Math.round(n * f) / f;
  };

  U.price = function (n, symbolId) {
    if (!U.isNum(n)) return '--';
    var inst = U.instrument(symbolId);
    var d = inst ? inst.digits : 5;
    return n.toFixed(d);
  };

  U.pct = function (n, d) {
    if (!U.isNum(n)) return '--';
    return (n * 100).toFixed(d == null ? 1 : d) + '%';
  };

  U.money = function (n) {
    if (!U.isNum(n)) return '--';
    var s = Math.abs(n).toFixed(2);
    return (n < 0 ? '-$' : '$') + s;
  };

  U.clamp = function (n, lo, hi) { return Math.min(hi, Math.max(lo, n)); };

  U.mean = function (a) {
    if (!a || !a.length) return null;
    var s = 0; for (var i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  };

  U.percentileOf = function (arr, value) {
    if (!arr || !arr.length) return null;
    var c = 0;
    for (var i = 0; i < arr.length; i++) if (arr[i] <= value) c++;
    return c / arr.length;
  };

  /* ---------- time & sessions ---------- */

  U.SESSIONS = ['SYDNEY', 'TOKYO', 'LONDON', 'LONDON_NY', 'NEW_YORK', 'OFF_HOURS'];

  // Session classification by UTC hour. Overlap is treated as its own session
  // because its liquidity/behaviour profile is genuinely different.
  U.sessionAt = function (ms) {
    var h = new Date(ms).getUTCHours();
    var day = new Date(ms).getUTCDay(); // 0 Sun .. 6 Sat
    if (day === 6) return 'OFF_HOURS';
    if (day === 0 && h < 21) return 'OFF_HOURS';
    if (day === 5 && h >= 21) return 'OFF_HOURS';
    if (h >= 13 && h < 16) return 'LONDON_NY';
    if (h >= 16 && h < 21) return 'NEW_YORK';
    if (h >= 7 && h < 13) return 'LONDON';
    if (h >= 0 && h < 7) return 'TOKYO';
    if (h >= 21) return 'SYDNEY';
    return 'OFF_HOURS';
  };

  U.SESSION_LIQUIDITY = {
    LONDON_NY: 1.0, LONDON: 0.9, NEW_YORK: 0.85, TOKYO: 0.6, SYDNEY: 0.4, OFF_HOURS: 0.2
  };

  U.SESSION_LABEL = {
    SYDNEY: 'Sydney', TOKYO: 'Tokyo', LONDON: 'London',
    LONDON_NY: 'London / New York overlap', NEW_YORK: 'New York', OFF_HOURS: 'Outside main sessions'
  };

  U.fmtTime = function (ms) {
    if (!ms) return '--';
    var d = new Date(ms);
    return d.toLocaleString(undefined, {
      month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  };

  U.fmtAgo = function (ms, nowMs) {
    if (!ms) return '--';
    var s = Math.max(0, Math.floor(((nowMs || Date.now()) - ms) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  };

  U.fmtIn = function (ms, nowMs) {
    if (!ms) return '--';
    var s = Math.floor((ms - (nowMs || Date.now())) / 1000);
    if (s <= 0) return 'expired';
    if (s < 3600) return 'in ' + Math.floor(s / 60) + 'm';
    if (s < 86400) return 'in ' + Math.floor(s / 3600) + 'h ' + (Math.floor(s / 60) % 60) + 'm';
    return 'in ' + Math.floor(s / 86400) + 'd';
  };

  /* ---------- sanitizing ---------- */

  // Escape everything. All external / AI text goes through here before it is
  // ever placed near innerHTML.
  U.esc = function (s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  // AI text -> safe paragraphs. Strips control chars, caps length, no markup survives.
  U.aiToParagraphs = function (text, maxChars) {
    var t = String(text == null ? '' : text)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .slice(0, maxChars || 4000);
    var parts = t.split(/\n{2,}/).map(function (p) { return p.trim(); }).filter(Boolean);
    return parts.map(function (p) { return U.esc(p).replace(/\n/g, '<br>'); });
  };

  U.id = function (prefix) {
    var r = (root.crypto && root.crypto.randomUUID)
      ? root.crypto.randomUUID().slice(0, 12)
      : Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    return (prefix || 'id') + '_' + r;
  };

  /* ---------- stats primitives ---------- */

  // Wilson score interval for a binomial proportion. Used for honest win-rate bands.
  U.wilson = function (wins, n, z) {
    if (!n) return null;
    z = z || 1.6449; // 90%
    var p = wins / n, z2 = z * z;
    var denom = 1 + z2 / n;
    var centre = p + z2 / (2 * n);
    var margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
    return { p: p, lo: Math.max(0, (centre - margin) / denom), hi: Math.min(1, (centre + margin) / denom) };
  };

  // Beta-Binomial posterior mean with a prior pulled from a broader bucket.
  // strength = how many pseudo-observations the prior is worth.
  U.shrink = function (wins, n, priorP, strength) {
    var s = strength == null ? 20 : strength;
    var p0 = priorP == null ? 0.5 : priorP;
    return (wins + p0 * s) / (n + s);
  };

  /* ---------- correlated-evidence combiner ---------- */

  // Sums correlated sub-scores with geometric decay so four indicators that all
  // say the same thing cannot pay four times. Sorted desc, weights 1, .5, .25, ...
  U.diminishingSum = function (values, cap) {
    var v = values.slice().filter(U.isNum).sort(function (a, b) { return b - a; });
    var total = 0, w = 1;
    for (var i = 0; i < v.length; i++) { total += v[i] * w; w *= 0.5; }
    return cap == null ? total : Math.min(cap, total);
  };

})(typeof self !== 'undefined' ? self : this);
