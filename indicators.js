/* EdgePilot - indicators.js
 * Pure functions over an array of closed candles: {t,o,h,l,c,v}
 * Every function reads only candles[0..i]; nothing looks forward.
 */
(function (root) {
  'use strict';
  var EP = root.EP = root.EP || {};
  var U = EP.util;
  var I = EP.ind = {};

  I.closes = function (c) { return c.map(function (x) { return x.c; }); };

  I.sma = function (vals, p) {
    var out = new Array(vals.length).fill(null), s = 0;
    for (var i = 0; i < vals.length; i++) {
      s += vals[i];
      if (i >= p) s -= vals[i - p];
      if (i >= p - 1) out[i] = s / p;
    }
    return out;
  };

  I.ema = function (vals, p) {
    var out = new Array(vals.length).fill(null), k = 2 / (p + 1), prev = null, s = 0;
    for (var i = 0; i < vals.length; i++) {
      if (i < p - 1) { s += vals[i]; continue; }
      if (i === p - 1) { s += vals[i]; prev = s / p; out[i] = prev; continue; }
      prev = vals[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  };

  I.trueRange = function (c) {
    var out = new Array(c.length).fill(null);
    for (var i = 0; i < c.length; i++) {
      if (i === 0) { out[i] = c[i].h - c[i].l; continue; }
      var pc = c[i - 1].c;
      out[i] = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - pc), Math.abs(c[i].l - pc));
    }
    return out;
  };

  // Wilder-smoothed ATR.
  I.atr = function (c, p) {
    p = p || 14;
    var tr = I.trueRange(c), out = new Array(c.length).fill(null), prev = null, s = 0;
    for (var i = 0; i < c.length; i++) {
      if (i < p) { s += tr[i]; if (i === p - 1) { prev = s / p; out[i] = prev; } continue; }
      prev = (prev * (p - 1) + tr[i]) / p;
      out[i] = prev;
    }
    return out;
  };

  I.rsi = function (c, p) {
    p = p || 14;
    var out = new Array(c.length).fill(null), ag = 0, al = 0;
    for (var i = 1; i < c.length; i++) {
      var d = c[i].c - c[i - 1].c, g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
      if (i <= p) {
        ag += g; al += l;
        if (i === p) { ag /= p; al /= p; out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
        continue;
      }
      ag = (ag * (p - 1) + g) / p;
      al = (al * (p - 1) + l) / p;
      out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return out;
  };

  // ADX with +DI / -DI. Used only for regime classification, not for scoring.
  I.adx = function (c, p) {
    p = p || 14;
    var n = c.length;
    var tr = I.trueRange(c);
    var pdm = new Array(n).fill(0), ndm = new Array(n).fill(0);
    for (var i = 1; i < n; i++) {
      var up = c[i].h - c[i - 1].h, dn = c[i - 1].l - c[i].l;
      pdm[i] = (up > dn && up > 0) ? up : 0;
      ndm[i] = (dn > up && dn > 0) ? dn : 0;
    }
    var str = 0, sp = 0, sn = 0;
    var adx = new Array(n).fill(null), pdi = new Array(n).fill(null), ndi = new Array(n).fill(null);
    var dxs = [];
    for (var j = 1; j < n; j++) {
      if (j <= p) { str += tr[j]; sp += pdm[j]; sn += ndm[j]; if (j < p) continue; }
      else {
        str = str - str / p + tr[j];
        sp = sp - sp / p + pdm[j];
        sn = sn - sn / p + ndm[j];
      }
      if (str === 0) continue;
      var pd = 100 * sp / str, nd = 100 * sn / str;
      pdi[j] = pd; ndi[j] = nd;
      var dx = (pd + nd) === 0 ? 0 : 100 * Math.abs(pd - nd) / (pd + nd);
      dxs.push(dx);
      if (dxs.length === p) adx[j] = U.mean(dxs);
      else if (dxs.length > p) { adx[j] = (adx[j - 1] * (p - 1) + dx) / p; }
    }
    return { adx: adx, pdi: pdi, ndi: ndi };
  };

  I.macd = function (c, f, s, sig) {
    f = f || 12; s = s || 26; sig = sig || 9;
    var cl = I.closes(c), ef = I.ema(cl, f), es = I.ema(cl, s);
    var line = cl.map(function (_, i) { return (ef[i] == null || es[i] == null) ? null : ef[i] - es[i]; });
    var valid = line.filter(function (x) { return x != null; });
    var sigArr = I.ema(valid, sig);
    var out = new Array(line.length).fill(null), k = 0;
    for (var i = 0; i < line.length; i++) if (line[i] != null) out[i] = sigArr[k++];
    var hist = line.map(function (v, i) { return (v == null || out[i] == null) ? null : v - out[i]; });
    return { line: line, signal: out, hist: hist };
  };

  // Donchian channel over the PREVIOUS `p` bars (excludes current bar so a
  // breakout test is not trivially self-satisfying).
  I.donchian = function (c, p) {
    p = p || 20;
    var hi = new Array(c.length).fill(null), lo = new Array(c.length).fill(null);
    for (var i = 0; i < c.length; i++) {
      if (i < p) continue;
      var h = -Infinity, l = Infinity;
      for (var j = i - p; j < i; j++) { if (c[j].h > h) h = c[j].h; if (c[j].l < l) l = c[j].l; }
      hi[i] = h; lo[i] = l;
    }
    return { hi: hi, lo: lo };
  };

  // Fractal swing pivots. left/right = bars each side that must be exceeded.
  // A pivot at index i is only "confirmed" once i+right bars exist, so callers
  // must ignore the last `right` bars for decision-making.
  I.pivots = function (c, left, right) {
    left = left || 2; right = right || 2;
    var highs = [], lows = [];
    for (var i = left; i < c.length - right; i++) {
      var isH = true, isL = true;
      for (var j = i - left; j <= i + right; j++) {
        if (j === i) continue;
        if (c[j].h >= c[i].h) isH = false;
        if (c[j].l <= c[i].l) isL = false;
      }
      if (isH) highs.push({ i: i, t: c[i].t, p: c[i].h });
      if (isL) lows.push({ i: i, t: c[i].t, p: c[i].l });
    }
    return { highs: highs, lows: lows };
  };

  // Market structure from confirmed pivots only.
  // Returns UPTREND / DOWNTREND / RANGE / UNCLEAR plus the last levels.
  I.structure = function (c, left, right) {
    var pv = I.pivots(c, left || 2, right || 2);
    var H = pv.highs.slice(-3), L = pv.lows.slice(-3);
    var res = {
      state: 'UNCLEAR', quality: 0,
      lastHigh: H.length ? H[H.length - 1] : null,
      lastLow: L.length ? L[L.length - 1] : null,
      highs: H, lows: L
    };
    if (H.length < 2 || L.length < 2) return res;
    var hh = H[H.length - 1].p > H[H.length - 2].p;
    var hl = L[L.length - 1].p > L[L.length - 2].p;
    var lh = H[H.length - 1].p < H[H.length - 2].p;
    var ll = L[L.length - 1].p < L[L.length - 2].p;

    if (hh && hl) { res.state = 'UPTREND'; res.quality = (H.length >= 3 && L.length >= 3) ? 1 : 0.7; }
    else if (lh && ll) { res.state = 'DOWNTREND'; res.quality = (H.length >= 3 && L.length >= 3) ? 1 : 0.7; }
    else if ((hh && ll) || (lh && hl)) { res.state = 'RANGE'; res.quality = 0.5; }
    else { res.state = 'UNCLEAR'; res.quality = 0.25; }
    return res;
  };

  // Position of price inside the recent range: 0 = at the low, 1 = at the high.
  I.rangePosition = function (c, p) {
    p = p || 20;
    var n = c.length;
    if (n < p + 1) return null;
    var h = -Infinity, l = Infinity;
    for (var i = n - p; i < n; i++) { if (c[i].h > h) h = c[i].h; if (c[i].l < l) l = c[i].l; }
    if (h === l) return 0.5;
    return U.clamp((c[n - 1].c - l) / (h - l), 0, 1);
  };

  // Candle anatomy for the confirmation test.
  I.anatomy = function (k) {
    var range = k.h - k.l;
    if (range <= 0) return { range: 0, body: 0, bodyRatio: 0, upperWick: 0, lowerWick: 0, closePos: 0.5, bull: false, bear: false };
    var body = Math.abs(k.c - k.o);
    return {
      range: range,
      body: body,
      bodyRatio: body / range,
      upperWick: (k.h - Math.max(k.o, k.c)) / range,
      lowerWick: (Math.min(k.o, k.c) - k.l) / range,
      closePos: (k.c - k.l) / range,
      bull: k.c > k.o,
      bear: k.c < k.o
    };
  };

  // Supertrend, used only as one member of the (capped) momentum family.
  I.supertrend = function (c, p, mult) {
    p = p || 10; mult = mult || 3;
    var atr = I.atr(c, p), dir = new Array(c.length).fill(null), line = new Array(c.length).fill(null);
    var ub = null, lb = null, prevDir = 1;
    for (var i = 0; i < c.length; i++) {
      if (atr[i] == null) continue;
      var mid = (c[i].h + c[i].l) / 2;
      var u = mid + mult * atr[i], l = mid - mult * atr[i];
      ub = (ub == null || u < ub || c[i - 1].c > ub) ? u : ub;
      lb = (lb == null || l > lb || c[i - 1].c < lb) ? l : lb;
      if (prevDir === 1 && c[i].c < lb) prevDir = -1;
      else if (prevDir === -1 && c[i].c > ub) prevDir = 1;
      dir[i] = prevDir;
      line[i] = prevDir === 1 ? lb : ub;
    }
    return { dir: dir, line: line };
  };

  I.last = function (arr) {
    for (var i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
    return null;
  };

})(typeof self !== 'undefined' ? self : this);
