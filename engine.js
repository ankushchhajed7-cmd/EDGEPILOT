/* EdgePilot - engine.js
 * Six-stage signal pipeline. Pure and DOM-free: given candles and a `nowMs`,
 * it can only see bars that closed at or before `nowMs`. That property is what
 * makes the backtester honest, so do not add any lookahead here.
 */
(function (root) {
  'use strict';
  var EP = root.EP = root.EP || {};
  var U = EP.util, I = EP.ind;
  var E = EP.engine = {};

  E.GATES = [
    { n: '01', id: 'DATA',   label: 'Data quality' },
    { n: '02', id: 'REGIME', label: 'Market regime' },
    { n: '03', id: 'BIAS',   label: 'Higher timeframe bias' },
    { n: '04', id: 'SETUP',  label: 'Setup detection' },
    { n: '05', id: 'ENTRY',  label: 'Entry confirmation' },
    { n: '06', id: 'RISK',   label: 'Risk filters' }
  ];

  E.SCORE_GROUPS = [
    { id: 'bias',      label: 'Higher timeframe bias', max: 20 },
    { id: 'regime',    label: 'Market regime fit',     max: 15 },
    { id: 'structure', label: 'Market structure',      max: 20 },
    { id: 'trigger',   label: 'Entry trigger',         max: 20 },
    { id: 'stop',      label: 'Volatility & stop',     max: 10 },
    { id: 'news',      label: 'News & liquidity',      max: 10 },
    { id: 'rr',        label: 'Reward / risk',         max: 5 }
  ];

  E.STRATEGIES = {
    TREND_PULLBACK:   { label: 'Trend continuation pullback', family: 'TREND' },
    SR_REJECTION:     { label: 'Support / resistance rejection', family: 'MEANREV' },
    BREAKOUT_RETEST:  { label: 'Breakout and retest', family: 'TREND' },
    RANGE_REVERSAL:   { label: 'Range reversal', family: 'MEANREV' }
  };

  /* ================= Stage 1 - data quality ================= */

  function normalise(raw, tfMs, nowMs) {
    if (!raw || !raw.length) return [];
    var seen = {}, out = [];
    for (var i = 0; i < raw.length; i++) {
      var k = raw[i];
      if (!k || !U.isNum(k.o) || !U.isNum(k.h) || !U.isNum(k.l) || !U.isNum(k.c) || !U.isNum(k.t)) continue;
      if (k.o <= 0 || k.c <= 0) continue;
      if (k.h < Math.max(k.o, k.c) - 1e-9 || k.l > Math.min(k.o, k.c) + 1e-9) continue;
      if (seen[k.t]) continue;
      seen[k.t] = 1;
      // Only bars whose interval has fully elapsed. This is the closed-candle rule.
      if (k.t + tfMs > nowMs) continue;
      out.push(k);
    }
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }

  function countDuplicates(raw) {
    var seen = {}, d = 0;
    for (var i = 0; i < (raw || []).length; i++) {
      var t = raw[i] && raw[i].t;
      if (t == null) continue;
      if (seen[t]) d++; else seen[t] = 1;
    }
    return d;
  }

  function gapReport(c, tfMs) {
    var look = Math.min(120, c.length), bad = 0;
    for (var i = c.length - look + 1; i < c.length; i++) {
      if (i < 1) continue;
      var d = c[i].t - c[i - 1].t;
      if (d <= tfMs * 1.5) continue;
      // Weekend break is expected on FX/metals: Friday close -> Sunday/Monday open.
      var dow = new Date(c[i - 1].t).getUTCDay();
      if ((dow === 5 || dow === 6) && d <= tfMs + 3 * 86400000) continue;
      bad++;
    }
    return { checked: look, gaps: bad, ratio: look ? bad / look : 0 };
  }

  function flatBarRatio(c) {
    var look = Math.min(50, c.length), f = 0;
    for (var i = c.length - look; i < c.length; i++) if (c[i] && c[i].h === c[i].l) f++;
    return look ? f / look : 0;
  }

  E.checkData = function (candlesRaw, nowMs, settings) {
    var need = { '1day': 60, '4h': 120 };
    need[settings.entryTf] = 120;
    var issues = [], sets = {}, worst = 'OK';

    ['1day', '4h', settings.entryTf].forEach(function (tf) {
      var tfMs = U.TF_MS[tf];
      var raw = candlesRaw[tf] || [];
      var dups = countDuplicates(raw);
      var c = normalise(raw, tfMs, nowMs);
      sets[tf] = c;
      var lbl = U.TF_LABEL[tf] || tf;

      if (c.length < need[tf]) {
        issues.push({ sev: 'FAIL', text: lbl + ': only ' + c.length + ' closed candles, need ' + need[tf] + '.' });
        worst = 'FAIL';
        return;
      }
      var last = c[c.length - 1];
      var age = nowMs - (last.t + tfMs);
      // Weekend tolerance so Sunday evening does not look like a broken feed.
      var tol = tfMs * (settings.staleFactorTf || 2.5) + (tf === '1day' ? 3 * 86400000 : 0);
      if (U.sessionAt(nowMs) === 'OFF_HOURS') tol += 2 * 86400000;
      if (age > tol) {
        issues.push({ sev: 'FAIL', text: lbl + ': last closed candle is ' + U.fmtAgo(last.t + tfMs, nowMs) + '. Feed looks stale.' });
        worst = 'FAIL';
      }
      if (dups > 0) issues.push({ sev: 'WARN', text: lbl + ': ' + dups + ' duplicate timestamps discarded.' });
      var g = gapReport(c, tfMs);
      if (g.ratio > 0.08) {
        issues.push({ sev: 'WARN', text: lbl + ': ' + g.gaps + ' unexpected gaps in the last ' + g.checked + ' candles.' });
        if (worst === 'OK') worst = 'DEGRADED';
      }
      var fb = flatBarRatio(c);
      if (fb > 0.2) {
        issues.push({ sev: 'WARN', text: lbl + ': ' + Math.round(fb * 100) + '% of recent candles have zero range.' });
        if (worst === 'OK') worst = 'DEGRADED';
      }
    });

    if (worst !== 'FAIL' && issues.some(function (x) { return x.sev === 'WARN'; }) && worst === 'OK') worst = 'DEGRADED';

    var entryC = sets[settings.entryTf] || [];
    var lastEntry = entryC.length ? entryC[entryC.length - 1] : null;
    return {
      status: worst,
      issues: issues,
      candles: sets,
      lastClosedAt: lastEntry ? lastEntry.t + U.TF_MS[settings.entryTf] : null,
      ageMs: lastEntry ? nowMs - (lastEntry.t + U.TF_MS[settings.entryTf]) : null
    };
  };

  /* ================= Stage 2 - regime ================= */

  E.regime = function (h4, d1, nowMs, news, settings) {
    var n = h4.length;
    var adx = I.adx(h4, 14);
    var atr = I.atr(h4, 14);
    var don = I.donchian(h4, 20);
    var cl = I.closes(h4);
    var e20 = I.ema(cl, 20), e50 = I.ema(cl, 50);
    var last = h4[n - 1];
    var a = adx.adx[n - 1], at = atr[n - 1];
    var atrHist = atr.slice(-120).filter(U.isNum);
    var atrPctile = at != null ? U.percentileOf(atrHist, at) : null;
    var session = U.sessionAt(nowMs);
    var liq = U.SESSION_LIQUIDITY[session];

    var flags = [];
    if (news && news.status === 'IMMINENT') flags.push('NEWS_RISK');
    if (liq <= 0.4 || (atrPctile != null && atrPctile < 0.15)) flags.push('LOW_LIQUIDITY');

    var primary = 'UNCERTAIN', detail = [];
    var brokeUp = don.hi[n - 1] != null && last.c > don.hi[n - 1];
    var brokeDn = don.lo[n - 1] != null && last.c < don.lo[n - 1];
    var expanding = atrPctile != null && atrPctile > 0.6;
    var emaAligned = (e20[n - 1] != null && e50[n - 1] != null) &&
      ((e20[n - 1] > e50[n - 1] && last.c > e50[n - 1]) || (e20[n - 1] < e50[n - 1] && last.c < e50[n - 1]));

    if (atrPctile != null && atrPctile > 0.9) {
      primary = 'HIGH_VOLATILITY';
      detail.push('H4 ATR is in the top ' + Math.round((1 - atrPctile) * 100) + '% of the last 120 candles.');
    } else if ((brokeUp || brokeDn) && expanding) {
      primary = 'BREAKOUT';
      detail.push('H4 closed ' + (brokeUp ? 'above' : 'below') + ' the 20-candle Donchian boundary with expanding range.');
    } else if (a != null && a >= (settings.adxTrend || 22) && emaAligned) {
      primary = 'TRENDING';
      detail.push('H4 ADX ' + U.round(a, 1) + ' with EMA20/50 aligned.');
    } else if (a != null && a < (settings.adxRange || 18)) {
      primary = 'RANGING';
      detail.push('H4 ADX ' + U.round(a, 1) + ', no directional pressure.');
    } else {
      detail.push('H4 ADX ' + U.round(a, 1) + ' sits between the trend and range thresholds.');
    }

    // Overlays outrank the structural label for display, because they change
    // what you should do more than the structure does.
    var display = flags.indexOf('NEWS_RISK') >= 0 ? 'NEWS_RISK'
      : (flags.indexOf('LOW_LIQUIDITY') >= 0 && primary !== 'HIGH_VOLATILITY' ? 'LOW_LIQUIDITY' : primary);

    return {
      primary: primary, display: display, flags: flags, detail: detail.join(' '),
      adx: a, atr: at, atrPercentile: atrPctile, session: session, liquidity: liq
    };
  };

  /* ================= Stage 3 - higher timeframe bias ================= */

  function tfBias(c) {
    var n = c.length, cl = I.closes(c);
    var e20 = I.ema(cl, 20), e50 = I.ema(cl, 50), e200 = I.ema(cl, 200);
    var st = I.structure(c, 2, 2);
    var price = c[n - 1].c;
    var slope = (e50[n - 1] != null && e50[n - 6] != null) ? (e50[n - 1] - e50[n - 6]) : null;

    var votes = 0, tot = 0;
    function v(cond, weight) { if (cond === null) return; tot += weight; votes += (cond ? weight : -weight); }
    v(e50[n - 1] != null ? price > e50[n - 1] : null, 2);
    v(slope != null ? slope > 0 : null, 2);
    v(st.state === 'UPTREND' ? true : (st.state === 'DOWNTREND' ? false : null), 3);
    v(e200[n - 1] != null ? price > e200[n - 1] : null, 1);

    var norm = tot ? votes / tot : 0; // -1 .. 1
    var dir = norm > 0.34 ? 'BULL' : (norm < -0.34 ? 'BEAR' : 'NEUTRAL');
    return { dir: dir, strength: Math.abs(norm), structure: st.state, structureQuality: st.quality, ema50: e50[n - 1], ema200: e200[n - 1] };
  }

  E.bias = function (d1, h4) {
    var b1 = tfBias(d1), b4 = tfBias(h4);
    var agreed = b1.dir === b4.dir && b1.dir !== 'NEUTRAL';
    var conflict = (b1.dir === 'BULL' && b4.dir === 'BEAR') || (b1.dir === 'BEAR' && b4.dir === 'BULL');
    return {
      d1: b1, h4: b4, agreed: agreed, conflict: conflict,
      direction: agreed ? b1.dir : 'NONE',
      strength: agreed ? (b1.strength + b4.strength) / 2 : 0
    };
  };

  /* ================= Stage 4 - setup detection ================= */

  function nearestLevel(levels, price, tolerance) {
    var best = null;
    for (var i = 0; i < levels.length; i++) {
      var d = Math.abs(levels[i].p - price);
      if (d <= tolerance && (!best || d < Math.abs(best.p - price))) best = levels[i];
    }
    return best;
  }

  E.detectSetups = function (ctx) {
    var entry = ctx.entryCandles, h4 = ctx.h4, n = entry.length;
    var atrArr = I.atr(entry, 14), atr = atrArr[n - 1];
    var cl = I.closes(entry);
    var e20 = I.ema(cl, 20), e50 = I.ema(cl, 50);
    var don = I.donchian(entry, 20);
    var st = I.structure(entry, 2, 2);
    var h4pv = I.pivots(h4, 2, 2);
    var last = entry[n - 1], prev = entry[n - 2];
    var bias = ctx.bias, regime = ctx.regime;
    var out = [];
    if (!U.isNum(atr) || atr <= 0) return out;

    var h4Levels = h4pv.highs.slice(-6).concat(h4pv.lows.slice(-6));
    var tol = atr * 0.9;

    /* --- Trend continuation pullback --- */
    if (regime.primary === 'TRENDING' && bias.agreed) {
      var up = bias.direction === 'BULL';
      var anchor = up ? Math.max(e20[n - 1], e50[n - 1]) : Math.min(e20[n - 1], e50[n - 1]);
      var touched = up ? (last.l <= anchor + atr * 0.4) : (last.h >= anchor - atr * 0.4);
      var stillSide = up ? last.c > e50[n - 1] - atr * 0.2 : last.c < e50[n - 1] + atr * 0.2;
      var structOk = up ? (st.state === 'UPTREND') : (st.state === 'DOWNTREND');
      if (touched && stillSide) {
        out.push({
          id: 'TREND_PULLBACK', dir: up ? 'BUY' : 'SELL',
          level: anchor,
          swing: up ? (st.lastLow ? st.lastLow.p : Math.min(last.l, prev.l)) : (st.lastHigh ? st.lastHigh.p : Math.max(last.h, prev.h)),
          structureOk: structOk, structureState: st.state, structureQuality: st.quality,
          notes: 'Price pulled back into the ' + U.TF_LABEL[ctx.entryTf] + ' EMA20/50 zone while ' +
                 (structOk ? 'structure still prints ' + (up ? 'higher lows' : 'lower highs') : 'structure reads ' + st.state.toLowerCase()) + '.'
        });
      }
    }

    /* --- Support / resistance rejection --- */
    var lvl = nearestLevel(h4Levels, last.c, tol);
    if (lvl) {
      var an = I.anatomy(last);
      var rejUp = an.lowerWick >= 0.45 && last.l <= lvl.p + tol * 0.6 && last.c > lvl.p;
      var rejDn = an.upperWick >= 0.45 && last.h >= lvl.p - tol * 0.6 && last.c < lvl.p;
      if (rejUp || rejDn) {
        out.push({
          id: 'SR_REJECTION', dir: rejUp ? 'BUY' : 'SELL',
          level: lvl.p,
          swing: rejUp ? last.l : last.h,
          structureOk: rejUp ? st.state !== 'DOWNTREND' : st.state !== 'UPTREND',
          structureState: st.state, structureQuality: st.quality,
          notes: 'H4 swing level at ' + U.price(lvl.p, ctx.symbol) + ' rejected with a ' +
                 Math.round((rejUp ? an.lowerWick : an.upperWick) * 100) + '% wick.'
        });
      }
    }

    /* --- Confirmed breakout and retest --- */
    if (don.hi[n - 1] != null) {
      for (var b = n - 12; b < n - 1; b++) {
        if (b < 21) continue;
        var upBreak = entry[b].c > don.hi[b];
        var dnBreak = entry[b].c < don.lo[b];
        if (!upBreak && !dnBreak) continue;
        var lvlB = upBreak ? don.hi[b] : don.lo[b];
        var retested = upBreak ? (last.l <= lvlB + atr * 0.5 && last.c > lvlB) : (last.h >= lvlB - atr * 0.5 && last.c < lvlB);
        if (!retested) continue;
        out.push({
          id: 'BREAKOUT_RETEST', dir: upBreak ? 'BUY' : 'SELL',
          level: lvlB,
          swing: upBreak ? Math.min(last.l, prev.l) : Math.max(last.h, prev.h),
          structureOk: upBreak ? st.state !== 'DOWNTREND' : st.state !== 'UPTREND',
          structureState: st.state, structureQuality: st.quality,
          notes: 'Break of the 20-candle boundary at ' + U.price(lvlB, ctx.symbol) + ' has been retested and held.'
        });
        break;
      }
    }

    /* --- Range reversal, ranging regime only --- */
    if (regime.primary === 'RANGING') {
      var rp = I.rangePosition(entry, 20);
      var anR = I.anatomy(last);
      if (rp != null && rp <= 0.15 && anR.bull && anR.closePos > 0.55) {
        out.push({
          id: 'RANGE_REVERSAL', dir: 'BUY', level: don.lo[n - 1] != null ? don.lo[n - 1] : last.l,
          swing: last.l, structureOk: true, structureState: st.state, structureQuality: st.quality,
          counterBias: bias.direction === 'BEAR',
          notes: 'Price is at the bottom ' + Math.round(rp * 100) + '% of the 20-candle range with a bullish close.'
        });
      }
      if (rp != null && rp >= 0.85 && anR.bear && anR.closePos < 0.45) {
        out.push({
          id: 'RANGE_REVERSAL', dir: 'SELL', level: don.hi[n - 1] != null ? don.hi[n - 1] : last.h,
          swing: last.h, structureOk: true, structureState: st.state, structureQuality: st.quality,
          counterBias: bias.direction === 'BULL',
          notes: 'Price is at the top ' + Math.round(rp * 100) + '% of the 20-candle range with a bearish close.'
        });
      }
    }

    return out;
  };

  /* ================= Stage 5 - entry confirmation ================= */

  E.confirmEntry = function (setup, ctx) {
    var entry = ctx.entryCandles, n = entry.length, last = entry[n - 1];
    var atr = I.atr(entry, 14)[n - 1];
    var an = I.anatomy(last);
    var rp = I.rangePosition(entry, 20);
    var buy = setup.dir === 'BUY';
    var fails = [], notes = [];

    if (an.range <= 0) fails.push('Confirmation candle has zero range.');

    // The closed confirmation candle must actually agree with the direction.
    var agrees = buy ? (an.bull && an.closePos >= 0.55) : (an.bear && an.closePos <= 0.45);
    if (!agrees) fails.push('Last closed candle does not confirm ' + setup.dir + ' (close sits at ' + Math.round(an.closePos * 100) + '% of its range).');
    else notes.push('Closed ' + (buy ? 'bullish' : 'bearish') + ' candle, close at ' + Math.round(an.closePos * 100) + '% of range.');

    // Do not chase an extended candle.
    var ext = atr ? an.range / atr : null;
    if (ext != null && ext > (ctx.settings.maxCandleAtr || 2.0)) {
      fails.push('Confirmation candle is ' + U.round(ext, 2) + 'x ATR. Too extended to chase.');
    } else if (ext != null) notes.push('Candle range is ' + U.round(ext, 2) + 'x ATR.');

    // Range-position gate.
    if (rp != null) {
      if (buy && rp > 0.80) fails.push('BUY rejected: price is in the top ' + Math.round((1 - rp) * 100) + '% of the recent range.');
      if (!buy && rp < 0.20) fails.push('SELL rejected: price is in the bottom ' + Math.round(rp * 100) + '% of the recent range.');
      if (!fails.length) notes.push('Range position ' + Math.round(rp * 100) + '%.');
    }

    return { ok: fails.length === 0, fails: fails, notes: notes, anatomy: an, rangePos: rp, extension: ext, atr: atr };
  };

  /* ================= levels, costs, sizing ================= */

  function costModel(symbol, settings) {
    var inst = U.instrument(symbol) || {};
    var ov = (settings.costs || {})[symbol] || {};
    return {
      spread: U.isNum(ov.spread) ? ov.spread : inst.defaultSpread,
      slippage: U.isNum(ov.slippage) ? ov.slippage : (inst.defaultSpread || 0) * 0.5,
      commissionPerLot: U.isNum(ov.commissionPerLot) ? ov.commissionPerLot : 7
    };
  }

  function pointValuePerLot(symbol, price) {
    var inst = U.instrument(symbol);
    if (!inst) return null;
    if (inst.kind === 'metal') return 100;      // 100 oz contract
    if (inst.kind === 'crypto') return 1;       // 1 BTC contract, broker dependent
    if (inst.quoteIsUsd === false) return 100000 / price; // USD is the base, convert to USD
    return 100000;
  }

  E.buildLevels = function (setup, ctx, conf) {
    var atr = conf.atr, buy = setup.dir === 'BUY';
    var s = ctx.settings, symbol = ctx.symbol;
    var cost = costModel(symbol, s);
    var last = ctx.entryCandles[ctx.entryCandles.length - 1];

    // Entry zone is anchored at the setup level, not at the market print.
    var lo = buy ? setup.level - atr * 0.15 : setup.level - atr * 0.35;
    var hi = buy ? setup.level + atr * 0.35 : setup.level + atr * 0.15;
    // Never quote a zone the market has already blown past.
    if (buy && last.c > hi) { hi = last.c; lo = Math.max(lo, last.c - atr * 0.5); }
    if (!buy && last.c < lo) { lo = last.c; hi = Math.min(hi, last.c + atr * 0.5); }
    var ref = buy ? (lo + hi) / 2 + cost.spread / 2 : (lo + hi) / 2 - cost.spread / 2;

    var swing = U.isNum(setup.swing) ? setup.swing : (buy ? last.l : last.h);
    var sl = buy ? Math.min(swing, lo) - atr * 0.5 : Math.max(swing, hi) + atr * 0.5;
    var stopDist = Math.abs(ref - sl);
    var stopAtr = stopDist / atr;

    // Structure-first targets with a hard R floor.
    var h4pv = I.pivots(ctx.h4, 2, 2);
    var opposing = (buy ? h4pv.highs : h4pv.lows).slice(-8)
      .map(function (x) { return x.p; })
      .filter(function (p) { return buy ? p > ref + stopDist * 1.2 : p < ref - stopDist * 1.2; })
      .sort(function (a, b) { return buy ? a - b : b - a; });

    // Structure-first, but clamped at both ends. A pivot 17R away is not a
    // target you will ever be paid at, and leaving it uncapped would let the
    // R:R group and the netRR filter both report a fantasy number.
    var maxR1 = s.maxTargetR1 || 3.0, maxR2 = s.maxTargetR2 || 5.0;
    function clampT(raw, minR, maxR) {
      var lo = buy ? ref + stopDist * minR : ref - stopDist * minR;
      var hi = buy ? ref + stopDist * maxR : ref - stopDist * maxR;
      if (buy) return U.clamp(raw, lo, hi);
      return U.clamp(raw, hi, lo);
    }
    var tp1 = clampT(opposing.length ? opposing[0] : (buy ? ref + stopDist * 1.5 : ref - stopDist * 1.5), 1.5, maxR1);
    var tp2 = clampT(opposing.length > 1 ? opposing[1] : (buy ? ref + stopDist * 2.5 : ref - stopDist * 2.5), 2.2, maxR2);
    if (buy ? tp2 <= tp1 : tp2 >= tp1) tp2 = buy ? ref + stopDist * maxR2 : ref - stopDist * maxR2;

    var vpp = pointValuePerLot(symbol, ref);
    var riskAmount = (s.accountBalance || 1000) * ((s.riskPercent || 0.5) / 100);
    var commissionPrice = vpp ? (cost.commissionPerLot / vpp) : 0; // commission expressed in price units per lot
    var grossR1 = Math.abs(tp1 - ref), grossR2 = Math.abs(tp2 - ref);
    var costPrice = cost.slippage + commissionPrice;
    var netRisk = stopDist + costPrice;
    var netRR1 = netRisk > 0 ? (grossR1 - costPrice) / netRisk : 0;
    var netRR2 = netRisk > 0 ? (grossR2 - costPrice) / netRisk : 0;

    var lots = (vpp && stopDist > 0) ? riskAmount / (stopDist * vpp) : null;
    if (lots != null) lots = Math.max(0.01, Math.floor(lots * 100) / 100);

    return {
      entryLow: Math.min(lo, hi), entryHigh: Math.max(lo, hi), entryRef: ref,
      sl: sl, tp1: tp1, tp2: tp2,
      stopDistance: stopDist, stopAtr: stopAtr,
      rr1: stopDist ? grossR1 / stopDist : 0,
      rr2: stopDist ? grossR2 / stopDist : 0,
      netRR1: netRR1, netRR2: netRR2,
      costs: cost, costPrice: costPrice,
      size: {
        lots: lots, riskAmount: riskAmount, pointValuePerLot: vpp,
        note: 'Estimate only. Confirm contract size and margin with your broker before sending an order.'
      }
    };
  };

  /* ================= Stage 6 - risk filters ================= */

  E.riskFilters = function (setup, ctx, conf, lv) {
    var s = ctx.settings, fails = [], warns = [], passes = [];
    var minRR = s.minRR || 1.5;

    if (lv.netRR1 < minRR) fails.push('Net R:R to target 1 is ' + U.round(lv.netRR1, 2) + ':1 after costs. Minimum is ' + minRR + ':1.');
    else passes.push('Net R:R to target 1 is ' + U.round(lv.netRR1, 2) + ':1 after spread, commission and slippage.');

    var loA = s.minStopAtr || 0.8, hiA = s.maxStopAtr || 3.0;
    if (lv.stopAtr < loA) fails.push('Stop is only ' + U.round(lv.stopAtr, 2) + 'x ATR. Too tight for current volatility.');
    else if (lv.stopAtr > hiA) fails.push('Stop is ' + U.round(lv.stopAtr, 2) + 'x ATR. Too wide to size responsibly.');
    else passes.push('Stop distance is ' + U.round(lv.stopAtr, 2) + 'x ATR.');

    var n = ctx.news || { status: 'UNKNOWN' };
    if (n.status === 'IMMINENT') fails.push('High impact event ' + (n.minutesToNext != null ? 'in ' + n.minutesToNext + ' minutes' : 'inside the blackout window') + '.');
    else if (n.status === 'NEAR') warns.push('High impact event in about ' + n.minutesToNext + ' minutes. Spread and slippage risk is elevated.');
    else if (n.status === 'UNKNOWN') warns.push('No economic calendar is connected. News risk is unverified, not cleared.');
    else passes.push('No high impact event inside the filter window.');

    var maxSpreadAtr = s.maxSpreadAtr || 0.15;
    var spreadAtr = conf.atr ? lv.costs.spread / conf.atr : null;
    if (spreadAtr != null && spreadAtr > maxSpreadAtr) fails.push('Spread is ' + U.round(spreadAtr, 3) + 'x ATR, above the ' + maxSpreadAtr + 'x limit.');
    else if (spreadAtr != null) passes.push('Spread is ' + U.round(spreadAtr, 3) + 'x ATR.');

    if (ctx.regime.flags.indexOf('LOW_LIQUIDITY') >= 0 && !s.allowLowLiquidity) {
      fails.push('Low liquidity conditions (' + U.SESSION_LABEL[ctx.regime.session] + ').');
    }
    if (ctx.regime.primary === 'HIGH_VOLATILITY' && !s.allowHighVol) {
      fails.push('Volatility regime is extreme. Stop placement is unreliable here.');
    }

    var rs = ctx.riskState || {};
    if (rs.dailyLossHit) fails.push('Daily loss limit reached. New signals are blocked until the next session day.');
    if (rs.cooldownUntil && ctx.nowMs < rs.cooldownUntil) {
      fails.push('Cooldown active after consecutive losses. Resumes ' + U.fmtTime(rs.cooldownUntil) + '.');
    }
    if (rs.openForSymbol >= (s.maxOpenPerSymbol || 1)) {
      fails.push('An unresolved signal already exists for this instrument.');
    }

    return { ok: fails.length === 0, fails: fails, warns: warns, passes: passes, spreadAtr: spreadAtr };
  };

  /* ================= scoring ================= */

  E.score = function (setup, ctx, conf, lv, risk) {
    var g = {}, notes = {};

    /* bias 20 */
    var b = ctx.bias;
    if (b.agreed) {
      var st = (b.d1.strength + b.h4.strength) / 2;
      g.bias = st > 0.7 ? 20 : (st > 0.45 ? 15 : 11);
      notes.bias = 'D1 and H4 both read ' + b.direction + ' (strength ' + U.round(st, 2) + ').';
    } else if (b.conflict) {
      g.bias = 0;
      notes.bias = 'D1 says ' + b.d1.dir + ', H4 says ' + b.h4.dir + '.';
    } else {
      g.bias = 7;
      notes.bias = 'One higher timeframe is neutral (D1 ' + b.d1.dir + ', H4 ' + b.h4.dir + ').';
    }
    if (setup.id === 'RANGE_REVERSAL') { g.bias = Math.min(g.bias, 12); notes.bias += ' Capped: range reversal does not need trend agreement.'; }

    /* regime fit 15 */
    var ideal = { TREND_PULLBACK: 'TRENDING', BREAKOUT_RETEST: 'BREAKOUT', RANGE_REVERSAL: 'RANGING', SR_REJECTION: 'RANGING' };
    var ok2 = { TREND_PULLBACK: ['BREAKOUT'], BREAKOUT_RETEST: ['TRENDING'], RANGE_REVERSAL: [], SR_REJECTION: ['TRENDING', 'BREAKOUT'] };
    if (ctx.regime.primary === ideal[setup.id]) { g.regime = 15; notes.regime = 'Setup matches the ' + ctx.regime.primary + ' regime.'; }
    else if ((ok2[setup.id] || []).indexOf(ctx.regime.primary) >= 0) { g.regime = 9; notes.regime = 'Setup is workable but not ideal in a ' + ctx.regime.primary + ' regime.'; }
    else { g.regime = 3; notes.regime = 'Setup is out of place in a ' + ctx.regime.primary + ' regime.'; }

    /* structure 20 - pivots only, no indicators allowed in this group */
    var sq = setup.structureQuality || 0;
    var base = setup.structureOk ? 14 : 5;
    g.structure = U.clamp(base + sq * 6, 0, 20);
    notes.structure = U.TF_LABEL[ctx.entryTf] + ' structure reads ' + setup.structureState +
      (setup.structureOk ? ' and supports the direction.' : ' and does not support the direction.');

    /* trigger 20 - candle 8 + capped momentum family 7 + participation 5 */
    var an = conf.anatomy;
    var candlePts = U.clamp(an.bodyRatio * 5 + (setup.dir === 'BUY' ? an.closePos : 1 - an.closePos) * 3, 0, 8);

    var entry = ctx.entryCandles, n = entry.length, cl = I.closes(entry);
    var e20 = I.ema(cl, 20)[n - 1], e50 = I.ema(cl, 50)[n - 1];
    var rsi = I.rsi(entry, 14)[n - 1];
    var mac = I.macd(entry).hist[n - 1];
    var stnd = I.supertrend(entry, 10, 3).dir[n - 1];
    var buy = setup.dir === 'BUY';
    // These four are strongly correlated, so they are combined with geometric
    // decay and hard-capped at 7. Four agreeing indicators cannot pay four times.
    var fam = [];
    if (U.isNum(e20)) fam.push((buy ? entry[n - 1].c > e20 : entry[n - 1].c < e20) ? 4 : 0);
    if (U.isNum(e50) && U.isNum(e20)) fam.push((buy ? e20 > e50 : e20 < e50) ? 4 : 0);
    if (U.isNum(rsi)) fam.push((buy ? rsi > 50 && rsi < 72 : rsi < 50 && rsi > 28) ? 4 : 0);
    if (U.isNum(mac)) fam.push((buy ? mac > 0 : mac < 0) ? 4 : 0);
    if (U.isNum(stnd)) fam.push((buy ? stnd === 1 : stnd === -1) ? 4 : 0);
    var famPts = U.diminishingSum(fam, 7);

    var vols = entry.slice(-21, -1).map(function (k) { return k.v || 0; });
    var avgV = U.mean(vols), curV = entry[n - 1].v || 0;
    var partPts = (avgV && curV) ? U.clamp((curV / avgV) * 2.5, 0, 5) : 2.5;

    g.trigger = U.clamp(candlePts + famPts + partPts, 0, 20);
    notes.trigger = 'Confirmation candle ' + U.round(candlePts, 1) + '/8, momentum family ' + U.round(famPts, 1) +
      '/7 (capped, correlated), participation ' + U.round(partPts, 1) + '/5.';

    /* volatility & stop 10 */
    var sa = lv.stopAtr;
    g.stop = (sa >= 1.0 && sa <= 2.0) ? 10 : ((sa >= 0.8 && sa <= 2.5) ? 6 : 2);
    var ap = ctx.regime.atrPercentile;
    if (ap != null && (ap > 0.9 || ap < 0.1)) g.stop = Math.max(0, g.stop - 3);
    notes.stop = 'Stop is ' + U.round(sa, 2) + 'x ATR; H4 ATR percentile ' + (ap != null ? Math.round(ap * 100) + '%' : 'unknown') + '.';

    /* news & liquidity 10 */
    var nw = ctx.news || { status: 'UNKNOWN' };
    var newsPts = nw.status === 'CLEAR' ? 7 : (nw.status === 'UNKNOWN' ? 3 : (nw.status === 'NEAR' ? 1 : 0));
    var liqPts = U.clamp((ctx.regime.liquidity || 0.2) * 3, 0, 3);
    g.news = U.clamp(newsPts + liqPts, 0, 10);
    notes.news = 'Calendar status ' + nw.status + '; session ' + U.SESSION_LABEL[ctx.regime.session] + '.';

    /* reward / risk 5 */
    var r = lv.netRR1;
    g.rr = r >= 2.5 ? 5 : (r >= 2.0 ? 4 : (r >= 1.75 ? 3 : (r >= 1.5 ? 2 : 0)));
    notes.rr = 'Net R:R ' + U.round(r, 2) + ':1 after costs.';

    var total = 0;
    E.SCORE_GROUPS.forEach(function (grp) { g[grp.id] = U.clamp(U.round(g[grp.id] || 0, 1), 0, grp.max); total += g[grp.id]; });

    return {
      total: U.round(total, 1),
      groups: g,
      notes: notes,
      indicators: { ema20: e20, ema50: e50, rsi14: rsi, macdHist: mac, supertrendDir: stnd, atr14: conf.atr, adxH4: ctx.regime.adx }
    };
  };

  /* ================= orchestration ================= */

  function gate(n, id, label, status, detail) {
    return { n: n, id: id, label: label, status: status, detail: detail };
  }

  E.analyze = function (ctx) {
    var s = ctx.settings, nowMs = ctx.nowMs;
    var sig = {
      id: U.id('sig'),
      createdAt: nowMs,
      symbol: ctx.symbol,
      entryTf: s.entryTf,
      decision: 'NO_TRADE',
      gates: [],
      failedAt: null,
      session: U.sessionAt(nowMs),
      reasons: { pass: [], fail: [], warn: [] },
      score: null, confidence: null, history: null,
      engineVersion: E.VERSION
    };

    /* 01 data */
    var dq = E.checkData(ctx.candles, nowMs, s);
    sig.dataQuality = { status: dq.status, issues: dq.issues, lastClosedAt: dq.lastClosedAt, ageMs: dq.ageMs };
    if (dq.status === 'FAIL') {
      sig.gates.push(gate('01', 'DATA', 'Data quality', 'FAIL', dq.issues.map(function (x) { return x.text; }).join(' ')));
      sig.failedAt = 'DATA';
      sig.reasons.fail = dq.issues.map(function (x) { return x.text; });
      return sig;
    }
    sig.gates.push(gate('01', 'DATA', 'Data quality', dq.status === 'OK' ? 'PASS' : 'WARN',
      dq.status === 'OK' ? 'Closed candles verified across D1, H4 and ' + U.TF_LABEL[s.entryTf] + '.'
        : dq.issues.map(function (x) { return x.text; }).join(' ')));
    if (dq.status === 'DEGRADED') sig.reasons.warn.push('Data quality is degraded. Treat any output with extra caution.');

    var d1 = dq.candles['1day'], h4 = dq.candles['4h'], entry = dq.candles[s.entryTf];

    /* 02 regime */
    var regime = E.regime(h4, d1, nowMs, ctx.news, s);
    sig.regime = regime;
    sig.gates.push(gate('02', 'REGIME', 'Market regime',
      (regime.primary === 'HIGH_VOLATILITY' || regime.flags.length) ? 'WARN' : 'PASS',
      regime.display + '. ' + regime.detail));

    /* 03 bias */
    var bias = E.bias(d1, h4);
    sig.bias = bias;
    var reversalAllowed = s.allowCounterBiasRangeReversal && regime.primary === 'RANGING';
    if (bias.conflict && !reversalAllowed) {
      sig.gates.push(gate('03', 'BIAS', 'Higher timeframe bias', 'FAIL',
        'D1 bias is ' + bias.d1.dir + ' while H4 bias is ' + bias.h4.dir + '. No reversal strategy is enabled.'));
      sig.failedAt = 'BIAS';
      sig.reasons.fail.push('Daily and 4-hour bias disagree, and counter-bias range reversal is switched off.');
      return sig;
    }
    sig.gates.push(gate('03', 'BIAS', 'Higher timeframe bias', bias.agreed ? 'PASS' : 'WARN',
      'D1 ' + bias.d1.dir + ' / H4 ' + bias.h4.dir + (bias.agreed ? '' : ' - lower conviction, range setups only.')));

    /* 04 setup */
    var ectx = {
      symbol: ctx.symbol, entryTf: s.entryTf, entryCandles: entry, h4: h4, d1: d1,
      bias: bias, regime: regime, settings: s, news: ctx.news, nowMs: nowMs, riskState: ctx.riskState
    };
    var setups = E.detectSetups(ectx);
    if (bias.conflict) setups = setups.filter(function (x) { return x.id === 'RANGE_REVERSAL'; });
    if (!setups.length) {
      sig.gates.push(gate('04', 'SETUP', 'Setup detection', 'FAIL', 'No qualifying pattern on ' + U.TF_LABEL[s.entryTf] + ' right now.'));
      sig.failedAt = 'SETUP';
      sig.reasons.fail.push('None of the four setup patterns are present on the last closed candle.');
      return sig;
    }
    sig.gates.push(gate('04', 'SETUP', 'Setup detection', 'PASS',
      setups.length + ' candidate pattern' + (setups.length > 1 ? 's' : '') + ': ' +
      setups.map(function (x) { return E.STRATEGIES[x.id].label + ' (' + x.dir + ')'; }).join(', ') + '.'));

    /* 05 entry + 06 risk, evaluated per candidate */
    var candidates = [], rejected = [];
    setups.forEach(function (st) {
      var conf = E.confirmEntry(st, ectx);
      if (!conf.ok) { rejected.push({ setup: st, stage: 'ENTRY', fails: conf.fails }); return; }
      var lv = E.buildLevels(st, ectx, conf);
      var risk = E.riskFilters(st, ectx, conf, lv);
      if (!risk.ok) { rejected.push({ setup: st, stage: 'RISK', fails: risk.fails }); return; }
      var sc = E.score(st, ectx, conf, lv, risk);
      candidates.push({ setup: st, conf: conf, levels: lv, risk: risk, score: sc });
    });

    if (!candidates.length) {
      var stage = rejected[0].stage;
      var all = [];
      rejected.forEach(function (r) { r.fails.forEach(function (f) { all.push(E.STRATEGIES[r.setup.id].label + ': ' + f); }); });
      sig.gates.push(gate('05', 'ENTRY', 'Entry confirmation', stage === 'ENTRY' ? 'FAIL' : 'PASS',
        stage === 'ENTRY' ? all.join(' ') : 'Confirmation candle accepted.'));
      if (stage !== 'ENTRY') sig.gates.push(gate('06', 'RISK', 'Risk filters', 'FAIL', all.join(' ')));
      sig.failedAt = stage;
      sig.reasons.fail = all;
      sig.rejectedSetups = rejected.map(function (r) { return { id: r.setup.id, label: E.STRATEGIES[r.setup.id].label, stage: r.stage, fails: r.fails }; });
      return sig;
    }

    /* strategy voting - weights come from resolved history, never from the score */
    var vote = (EP.stats && EP.stats.voteOn)
      ? EP.stats.voteOn(candidates, ectx, ctx.weights)
      : { winner: candidates[0], noTradeShare: 0, weighted: false, detail: 'Voting unavailable; highest raw score used.' };

    sig.vote = { weighted: vote.weighted, noTradeShare: vote.noTradeShare, detail: vote.detail, table: vote.table || [] };

    if (vote.noTradeShare > 0.5) {
      sig.gates.push(gate('05', 'ENTRY', 'Entry confirmation', 'PASS', 'Confirmation candle accepted.'));
      sig.gates.push(gate('06', 'RISK', 'Risk filters', 'WARN', 'Hard filters passed, but weighted strategy history votes against taking it.'));
      sig.decision = 'NO_TRADE';
      sig.failedAt = 'VOTE';
      sig.reasons.fail.push('Strategies with a losing record in this exact context hold ' + Math.round(vote.noTradeShare * 100) + '% of the weighted vote.');
      return sig;
    }

    var w = vote.winner;
    sig.gates.push(gate('05', 'ENTRY', 'Entry confirmation', 'PASS', w.conf.notes.join(' ')));
    sig.gates.push(gate('06', 'RISK', 'Risk filters', w.risk.warns.length ? 'WARN' : 'PASS',
      w.risk.passes.concat(w.risk.warns).join(' ')));

    sig.setup = {
      id: w.setup.id, label: E.STRATEGIES[w.setup.id].label, family: E.STRATEGIES[w.setup.id].family,
      notes: w.setup.notes, counterBias: !!w.setup.counterBias
    };
    sig.direction = w.setup.dir;
    sig.levels = w.levels;
    sig.costs = w.levels.costs;
    sig.size = w.levels.size;
    sig.atr = w.conf.atr;
    sig.entryConfirm = { notes: w.conf.notes, rangePos: w.conf.rangePos, extension: w.conf.extension };
    sig.score = w.score;
    sig.indicators = w.score.indicators;
    sig.news = ctx.news || { status: 'UNKNOWN' };
    sig.reasons.pass = w.risk.passes.concat(w.conf.notes);
    sig.reasons.warn = sig.reasons.warn.concat(w.risk.warns);
    sig.rejectedSetups = rejected.map(function (r) { return { id: r.setup.id, label: E.STRATEGIES[r.setup.id].label, stage: r.stage, fails: r.fails }; });

    var expiryBars = s.expiryBars || 12;
    sig.expiresAt = entry[entry.length - 1].t + U.TF_MS[s.entryTf] * (expiryBars + 1);

    // Decision. A passing setup below the score threshold is a WAIT, not a trade.
    var minScore = s.minScore || 62;
    if (w.score.total < minScore) {
      sig.decision = 'WAIT';
      sig.reasons.warn.push('Setup score ' + w.score.total + ' is below your ' + minScore + ' threshold. Watch, do not enter.');
    } else if (sig.dataQuality.status === 'DEGRADED') {
      sig.decision = 'WAIT';
      sig.reasons.warn.push('Filters passed but the data feed is degraded. Verify on your platform before acting.');
    } else {
      sig.decision = w.setup.dir;
    }

    sig.contextKey = EP.stats ? EP.stats.contextKey(sig) : null;
    return sig;
  };

  E.VERSION = '1.0.0';

})(typeof self !== 'undefined' ? self : this);
