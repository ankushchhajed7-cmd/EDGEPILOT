/* EdgePilot - stats.js
 * Everything that turns resolved signals into numbers we are willing to show.
 * Rule enforced throughout: nothing here is derived from the setup score alone.
 */
(function (root) {
  'use strict';
  var EP = root.EP = root.EP || {};
  var U = EP.util;
  var S = EP.stats = {};

  S.MIN_SAMPLE = 30;        // before a context win rate is shown at all
  S.MIN_WEIGHT_SAMPLE = 20; // before strategy voting stops being equal-weight
  S.SCORE_BANDS = [[0, 60], [60, 70], [70, 80], [80, 90], [90, 101]];

  S.contextKey = function (sig) {
    return [sig.symbol, sig.entryTf, sig.regime ? sig.regime.primary : 'NA', sig.session].join('|');
  };

  S.keyChain = function (sig) {
    var r = sig.regime ? sig.regime.primary : 'NA';
    return [
      { level: 'exact',   key: [sig.symbol, sig.entryTf, r, sig.session].join('|'), label: 'this pair, timeframe, regime and session' },
      { level: 'regime',  key: [sig.symbol, sig.entryTf, r, '*'].join('|'),         label: 'this pair, timeframe and regime' },
      { level: 'pair',    key: [sig.symbol, sig.entryTf, '*', '*'].join('|'),       label: 'this pair and timeframe' },
      { level: 'global',  key: ['*', '*', '*', '*'].join('|'),                      label: 'all resolved signals' }
    ];
  };

  function matches(sig, key) {
    var p = key.split('|');
    var f = [sig.symbol, sig.entryTf, sig.regime ? sig.regime.primary : 'NA', sig.session];
    for (var i = 0; i < 4; i++) if (p[i] !== '*' && p[i] !== f[i]) return false;
    return true;
  }
  S.matches = matches;

  S.isCounted = function (r) {
    // Signals that never filled are not trades and must not pollute the win rate.
    return r && r.outcome && r.outcome !== 'EXPIRED_NO_FILL' && U.isNum(r.rMultiple);
  };

  /* ================= core performance ================= */

  S.performance = function (resolved) {
    var list = (resolved || []).filter(S.isCounted)
      .slice().sort(function (a, b) { return a.resolvedAt - b.resolvedAt; });
    var n = list.length;
    var out = {
      n: n, wins: 0, losses: 0, winRate: null, band: null,
      avgWinR: null, avgLossR: null, expectancyR: null, profitFactor: null,
      maxDrawdownR: null, maxLosingStreak: 0, totalR: 0,
      avgMfeR: null, avgMaeR: null, equity: []
    };
    if (!n) return out;

    var winsR = [], lossR = [], eq = 0, peak = 0, dd = 0, streak = 0, mfe = [], mae = [];
    for (var i = 0; i < n; i++) {
      var r = list[i];
      if (r.rMultiple > 0) { out.wins++; winsR.push(r.rMultiple); streak = 0; }
      else { out.losses++; lossR.push(Math.abs(r.rMultiple)); streak++; if (streak > out.maxLosingStreak) out.maxLosingStreak = streak; }
      eq += r.rMultiple;
      if (eq > peak) peak = eq;
      if (peak - eq > dd) dd = peak - eq;
      out.equity.push(U.round(eq, 3));
      if (U.isNum(r.mfeR)) mfe.push(r.mfeR);
      if (U.isNum(r.maeR)) mae.push(r.maeR);
    }
    out.totalR = U.round(eq, 3);
    out.winRate = out.wins / n;
    out.band = U.wilson(out.wins, n);
    out.avgWinR = winsR.length ? U.round(U.mean(winsR), 3) : null;
    out.avgLossR = lossR.length ? U.round(U.mean(lossR), 3) : null;
    out.expectancyR = U.round(eq / n, 3);
    var gp = winsR.reduce(function (a, b) { return a + b; }, 0);
    var gl = lossR.reduce(function (a, b) { return a + b; }, 0);
    out.profitFactor = gl > 0 ? U.round(gp / gl, 2) : (gp > 0 ? Infinity : null);
    out.maxDrawdownR = U.round(dd, 3);
    out.avgMfeR = mfe.length ? U.round(U.mean(mfe), 2) : null;
    out.avgMaeR = mae.length ? U.round(U.mean(mae), 2) : null;
    return out;
  };

  S.recent = function (resolved, k) {
    var list = (resolved || []).filter(S.isCounted)
      .slice().sort(function (a, b) { return a.resolvedAt - b.resolvedAt; });
    return S.performance(list.slice(-k));
  };

  S.groupBy = function (resolved, field) {
    var map = {};
    (resolved || []).filter(S.isCounted).forEach(function (r) {
      var k = field === 'regime' ? (r.regime && r.regime.primary) || 'NA' : r[field];
      if (k == null) k = 'NA';
      (map[k] = map[k] || []).push(r);
    });
    return Object.keys(map).sort().map(function (k) {
      var p = S.performance(map[k]);
      p.key = k;
      return p;
    });
  };

  /* ================= context history for a live signal ================= */

  S.historyFor = function (sig, resolved, minSample) {
    var min = minSample || S.MIN_SAMPLE;
    var chain = S.keyChain(sig);
    for (var i = 0; i < chain.length; i++) {
      var subset = (resolved || []).filter(function (r) { return S.isCounted(r) && matches(r, chain[i].key); });
      var perf = S.performance(subset);
      if (perf.n >= min) {
        return {
          available: true, level: chain[i].level, label: chain[i].label,
          n: perf.n, winRate: perf.winRate, band: perf.band,
          expectancyR: perf.expectancyR, profitFactor: perf.profitFactor,
          last30: S.recent(subset, 30), last50: S.recent(subset, 50),
          exactN: (resolved || []).filter(function (r) { return S.isCounted(r) && matches(r, chain[0].key); }).length
        };
      }
    }
    var exact = (resolved || []).filter(function (r) { return S.isCounted(r) && matches(r, chain[0].key); });
    return {
      available: false, level: 'exact', label: chain[0].label,
      n: exact.length, needed: min, exactN: exact.length,
      last30: S.recent(exact, 30), last50: S.recent(exact, 50)
    };
  };

  /* ================= calibration ================= */

  // Maps setup-score bands to the win rate those bands actually produced.
  S.calibrate = function (resolved) {
    var list = (resolved || []).filter(function (r) { return S.isCounted(r) && r.score && U.isNum(r.score.total); });
    var global = S.performance(list);
    var bands = S.SCORE_BANDS.map(function (b) {
      var sub = list.filter(function (r) { return r.score.total >= b[0] && r.score.total < b[1]; });
      var p = S.performance(sub);
      return {
        lo: b[0], hi: b[1], n: p.n, wins: p.wins,
        rawWinRate: p.winRate,
        shrunkWinRate: p.n ? U.shrink(p.wins, p.n, global.winRate == null ? 0.5 : global.winRate, 20) : null,
        band: p.band, expectancyR: p.expectancyR
      };
    });
    var covered = bands.filter(function (b) { return b.n >= 15; }).length;
    return {
      bands: bands,
      totalN: global.n,
      globalWinRate: global.winRate,
      status: global.n < 40 ? 'UNCALIBRATED' : (covered < 3 ? 'PARTIAL' : 'CALIBRATED')
    };
  };

  // Model confidence is the calibrated probability that this score band wins.
  // It deliberately ignores how confident the engine "feels".
  S.confidenceFor = function (sig, calibration) {
    if (!sig.score || !calibration) return { available: false, status: 'UNCALIBRATED', reason: 'No resolved signals yet.' };
    if (calibration.status === 'UNCALIBRATED') {
      return {
        available: false, status: 'UNCALIBRATED',
        totalN: calibration.totalN,
        reason: 'Only ' + calibration.totalN + ' resolved signals recorded. At least 40 are needed before any confidence number is meaningful.'
      };
    }
    var t = sig.score.total, band = null;
    for (var i = 0; i < calibration.bands.length; i++) {
      var b = calibration.bands[i];
      if (t >= b.lo && t < b.hi) { band = b; break; }
    }
    if (!band || band.n < 15) {
      return {
        available: false, status: 'THIN_BAND',
        n: band ? band.n : 0,
        reason: 'Only ' + (band ? band.n : 0) + ' resolved signals fall in the ' + (band ? band.lo + '-' + band.hi : 'this') + ' score band. Need 15.'
      };
    }
    return {
      available: true, status: calibration.status,
      value: band.shrunkWinRate, raw: band.rawWinRate, n: band.n,
      band: band.band, lo: band.lo, hi: band.hi,
      expectancyR: band.expectancyR,
      note: 'Calibrated from resolved outcomes in the ' + band.lo + '-' + band.hi + ' score band, shrunk toward the overall base rate.'
    };
  };

  /* ================= strategy weighting & voting ================= */

  S.buildWeights = function (resolved) {
    var byStrategy = {}, all = (resolved || []).filter(S.isCounted);
    all.forEach(function (r) {
      var sid = r.setup && r.setup.id;
      if (!sid) return;
      var chain = S.keyChain(r);
      (byStrategy[sid] = byStrategy[sid] || { buckets: {}, global: { n: 0, wins: 0, sumR: 0 } });
      var b = byStrategy[sid];
      b.global.n++; b.global.sumR += r.rMultiple; if (r.rMultiple > 0) b.global.wins++;
      chain.forEach(function (c) {
        var k = c.key;
        var bk = b.buckets[k] = b.buckets[k] || { n: 0, wins: 0, sumR: 0, level: c.level };
        bk.n++; bk.sumR += r.rMultiple; if (r.rMultiple > 0) bk.wins++;
      });
    });
    return { byStrategy: byStrategy, builtAt: Date.now(), totalResolved: all.length };
  };

  function lookupStat(weights, strategyId, sig) {
    var empty = { n: 0, wins: 0, sumR: 0, level: 'none' };
    if (!weights || !weights.byStrategy || !weights.byStrategy[strategyId]) return empty;
    var b = weights.byStrategy[strategyId];
    var chain = S.keyChain(sig);
    for (var i = 0; i < chain.length; i++) {
      var bk = b.buckets[chain[i].key];
      if (bk && bk.n >= S.MIN_WEIGHT_SAMPLE) return { n: bk.n, wins: bk.wins, sumR: bk.sumR, level: chain[i].level };
    }
    var top = b.buckets[chain[0].key];
    return top ? { n: top.n, wins: top.wins, sumR: top.sumR, level: 'exact' } : empty;
  }

  // Shrunk expectancy in R. Prior is 0R (no edge), worth 15 pseudo-trades.
  function shrunkExpectancy(stat) {
    if (!stat || !stat.n) return 0;
    return stat.sumR / (stat.n + 15);
  }

  var FAMILY_CAP = 0.6;

  S.voteOn = function (candidates, ectx, weights) {
    var rows = [], sumFor = 0, sumNo = 0, anyWeighted = false;

    candidates.forEach(function (c) {
      var pseudoSig = {
        symbol: ectx.symbol, entryTf: ectx.entryTf,
        regime: ectx.regime, session: U.sessionAt(ectx.nowMs)
      };
      var stat = lookupStat(weights, c.setup.id, pseudoSig);
      var exp = shrunkExpectancy(stat);
      var scoreW = c.score.total / 100;
      var row = {
        strategy: c.setup.id,
        label: (EP.engine.STRATEGIES[c.setup.id] || {}).label || c.setup.id,
        family: (EP.engine.STRATEGIES[c.setup.id] || {}).family || 'OTHER',
        n: stat.n, level: stat.level, expectancyR: U.round(exp, 3),
        score: c.score.total, forWeight: 0, noTradeWeight: 0, weighted: false,
        candidate: c
      };
      if (stat.n >= S.MIN_WEIGHT_SAMPLE) {
        row.weighted = true; anyWeighted = true;
        if (exp <= 0) { row.noTradeWeight = 1; row.reason = 'Negative expectancy over ' + stat.n + ' resolved signals in this context.'; }
        else { row.forWeight = exp * scoreW; row.reason = 'Expectancy ' + U.round(exp, 2) + 'R over ' + stat.n + ' resolved signals.'; }
      } else {
        row.forWeight = 0.5 * scoreW;
        row.reason = 'Only ' + stat.n + ' resolved signals in this context. Equal weight applied until ' + S.MIN_WEIGHT_SAMPLE + '.';
      }
      rows.push(row);
    });

    // Correlated strategies in the same family cannot dominate the vote together.
    var famTotals = {};
    rows.forEach(function (r) { famTotals[r.family] = (famTotals[r.family] || 0) + r.forWeight; });
    var grand = Object.keys(famTotals).reduce(function (a, k) { return a + famTotals[k]; }, 0);
    // With a single family there is nothing to dilute, so capping would only
    // shrink the number without changing which strategy wins.
    if (grand > 0 && Object.keys(famTotals).length > 1) {
      Object.keys(famTotals).forEach(function (f) {
        if (famTotals[f] / grand > FAMILY_CAP) {
          var scale = (FAMILY_CAP * grand) / famTotals[f];
          rows.forEach(function (r) { if (r.family === f) { r.forWeight *= scale; r.capped = true; } });
        }
      });
    }

    rows.forEach(function (r) { sumFor += r.forWeight; sumNo += r.noTradeWeight; });
    var winner = null;
    rows.forEach(function (r) {
      if (r.noTradeWeight) return;
      if (!winner || r.forWeight > winner.forWeight ||
        (r.forWeight === winner.forWeight && r.score > winner.score)) winner = r;
    });

    return {
      winner: winner ? winner.candidate : candidates[0],
      noTradeShare: (sumFor + sumNo) > 0 ? sumNo / (sumFor + sumNo) : 0,
      weighted: anyWeighted,
      detail: anyWeighted
        ? 'Weighted by resolved history. Correlated families capped at ' + Math.round(FAMILY_CAP * 100) + '% of the vote.'
        : 'Not enough resolved history yet, so all detected strategies carry equal weight.',
      table: rows.map(function (r) {
        return {
          strategy: r.strategy, label: r.label, family: r.family, n: r.n, level: r.level,
          expectancyR: r.expectancyR, score: r.score,
          forWeight: U.round(r.forWeight, 3), noTradeWeight: r.noTradeWeight,
          weighted: r.weighted, capped: !!r.capped, reason: r.reason
        };
      })
    };
  };

  /* ================= resolution ================= */

  // Walks candles that closed AFTER the signal and decides the outcome.
  // Conservative by design: if one candle spans both stop and target, the stop wins.
  S.resolveSignal = function (sig, candlesAfter, settings) {
    if (!sig.levels || !sig.direction || (sig.direction !== 'BUY' && sig.direction !== 'SELL')) return null;
    var lv = sig.levels, buy = sig.direction === 'BUY';
    var holdBars = (settings && settings.holdBars) || 24;
    var risk = lv.stopDistance + lv.costPrice;
    if (!(risk > 0)) return null;

    var filled = false, fillAt = null, fillPrice = null, bars = 0, mfe = 0, mae = 0;
    var tp2Hit = false;

    for (var i = 0; i < candlesAfter.length; i++) {
      var k = candlesAfter[i];
      if (!filled) {
        if (k.t > sig.expiresAt) {
          return {
            outcome: 'EXPIRED_NO_FILL', resolvedAt: k.t, rMultiple: null,
            note: 'Price never traded into the entry zone before expiry.'
          };
        }
        var touches = k.l <= lv.entryHigh && k.h >= lv.entryLow;
        if (!touches) continue;
        filled = true; fillAt = k.t;
        fillPrice = buy ? Math.min(lv.entryHigh, Math.max(lv.entryLow, k.o)) : Math.max(lv.entryLow, Math.min(lv.entryHigh, k.o));
        if (buy && k.o > lv.entryHigh) fillPrice = lv.entryHigh;
        if (!buy && k.o < lv.entryLow) fillPrice = lv.entryLow;
      }

      bars++;
      var fav = buy ? (k.h - fillPrice) : (fillPrice - k.l);
      var adv = buy ? (fillPrice - k.l) : (k.h - fillPrice);
      if (fav > mfe) mfe = fav;
      if (adv > mae) mae = adv;

      var hitSL = buy ? k.l <= lv.sl : k.h >= lv.sl;
      var hitTP1 = buy ? k.h >= lv.tp1 : k.l <= lv.tp1;
      var hitTP2 = buy ? k.h >= lv.tp2 : k.l <= lv.tp2;
      if (hitTP2) tp2Hit = true;

      if (hitSL) {
        return {
          outcome: 'SL', resolvedAt: k.t, filledAt: fillAt, fillPrice: fillPrice, barsHeld: bars,
          rMultiple: U.round(-1, 3), mfeR: U.round(mfe / risk, 3), maeR: U.round(mae / risk, 3),
          tp2Reached: tp2Hit, ambiguousBar: hitTP1,
          note: hitTP1 ? 'Stop and target both inside one candle; counted as a loss.' : 'Stop-loss hit.'
        };
      }
      if (hitTP1) {
        var gross = Math.abs(lv.tp1 - fillPrice);
        return {
          outcome: 'TP', resolvedAt: k.t, filledAt: fillAt, fillPrice: fillPrice, barsHeld: bars,
          rMultiple: U.round((gross - lv.costPrice) / risk, 3),
          mfeR: U.round(mfe / risk, 3), maeR: U.round(mae / risk, 3),
          tp2Reached: tp2Hit, note: 'Target 1 reached.'
        };
      }
      if (bars >= holdBars) {
        var pnl = buy ? (k.c - fillPrice) : (fillPrice - k.c);
        return {
          outcome: 'TIMEOUT', resolvedAt: k.t, filledAt: fillAt, fillPrice: fillPrice, barsHeld: bars,
          rMultiple: U.round((pnl - lv.costPrice) / risk, 3),
          mfeR: U.round(mfe / risk, 3), maeR: U.round(mae / risk, 3),
          tp2Reached: tp2Hit, note: 'Closed at market after ' + holdBars + ' candles.'
        };
      }
    }
    return null; // still open
  };

})(typeof self !== 'undefined' ? self : this);
