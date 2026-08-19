/* EdgePilot - backtest.js
 * Walk-forward evaluation.
 *
 * Look-ahead control: at every step the engine is handed slices that end at the
 * bar which had already closed, and `nowMs` is that bar's close time. Weights
 * are rebuilt only from signals that had already resolved at that moment.
 *
 * Parameter search trick: minScore and minRR are pure gates applied after the
 * pipeline produces levels and a score, so one pass generates every candidate
 * and each parameter pair is evaluated by filtering. This is exactly equivalent
 * to re-running the pipeline per parameter set, and fast enough for a phone.
 */
(function (root) {
  'use strict';
  var EP = root.EP = root.EP || {};
  var U = EP.util, E = EP.engine, S = EP.stats;
  var B = EP.backtest = {};

  B.GRID = {
    minScore: [55, 62, 70, 78],
    minRR: [1.5, 2.0]
  };

  function sliceTo(candles, nowMs, tfMs, maxBars) {
    var out = [];
    for (var i = candles.length - 1; i >= 0; i--) {
      if (candles[i].t + tfMs > nowMs) continue;
      out.push(candles[i]);
      if (out.length >= maxBars) break;
    }
    return out.reverse();
  }

  function yieldNow() {
    return new Promise(function (r) { setTimeout(r, 0); });
  }

  /**
   * @param {Object} opts {symbol, candles:{'1day','4h',entryTf}, settings, folds, onProgress}
   */
  B.run = async function (opts) {
    var s = Object.assign({}, opts.settings, { minScore: 0, minRR: 1.5 });
    var tf = s.entryTf, tfMs = U.TF_MS[tf];
    var entry = (opts.candles[tf] || []).slice().sort(function (a, b) { return a.t - b.t; });
    var h4 = (opts.candles['4h'] || []).slice().sort(function (a, b) { return a.t - b.t; });
    var d1 = (opts.candles['1day'] || []).slice().sort(function (a, b) { return a.t - b.t; });

    var warmup = 210;
    if (entry.length < warmup + 120) {
      return { ok: false, error: 'Need at least ' + (warmup + 120) + ' ' + U.TF_LABEL[tf] + ' candles. Received ' + entry.length + '.' };
    }

    var raw = [], pending = [], resolvedSoFar = [], weights = null, sinceRebuild = 0;
    var total = entry.length - warmup;
    var chunk = 30;

    for (var t = warmup; t < entry.length; t++) {
      var nowMs = entry[t].t + tfMs;

      // Resolve anything that has become decidable using only bars up to t.
      for (var p = pending.length - 1; p >= 0; p--) {
        var ps = pending[p];
        var after = entry.slice(ps.barIndex + 1, t + 1);
        var res = S.resolveSignal(ps.signal, after, s);
        if (res) {
          var rec = Object.assign({}, ps.signal, res);
          resolvedSoFar.push(rec);
          raw[ps.rawIndex] = rec;
          pending.splice(p, 1);
          sinceRebuild++;
        }
      }
      if (sinceRebuild >= 20) { weights = S.buildWeights(resolvedSoFar); sinceRebuild = 0; }

      var sig = E.analyze({
        symbol: opts.symbol, nowMs: nowMs, settings: s,
        candles: {
          '1day': sliceTo(d1, nowMs, U.TF_MS['1day'], 160),
          '4h': sliceTo(h4, nowMs, U.TF_MS['4h'], 220),
          [tf]: sliceTo(entry, nowMs, tfMs, 260)
        },
        news: null, // no historical calendar available offline; treated as UNKNOWN
        weights: weights,
        riskState: {}
      });

      if (sig.levels && (sig.direction === 'BUY' || sig.direction === 'SELL')) {
        sig.barIndex = t;
        raw.push(sig);
        pending.push({ signal: sig, barIndex: t, rawIndex: raw.length - 1 });
      }

      if ((t - warmup) % chunk === 0) {
        if (opts.onProgress) opts.onProgress((t - warmup) / total, raw.length);
        await yieldNow();
      }
    }

    // Resolve the tail with whatever candles remain.
    pending.forEach(function (ps) {
      var res = S.resolveSignal(ps.signal, entry.slice(ps.barIndex + 1), s);
      if (res) raw[ps.rawIndex] = Object.assign({}, ps.signal, res);
    });

    var settled = raw.filter(function (r) { return r && r.outcome; });
    if (!settled.length) {
      return { ok: true, symbol: opts.symbol, entryTf: tf, totalCandidates: raw.length, settled: 0, note: 'The pipeline produced no resolved signals over this history.' };
    }

    /* ---- walk-forward folds over calendar time ---- */
    var folds = Math.max(2, Math.min(6, opts.folds || 4));
    var t0 = entry[warmup].t, t1 = entry[entry.length - 1].t;
    var span = (t1 - t0) / (folds + 1);
    var results = [], isAgg = [], oosAgg = [];

    for (var f = 0; f < folds; f++) {
      var trainA = t0 + span * f, trainB = t0 + span * (f + 1), testB = t0 + span * (f + 2);
      var train = settled.filter(function (r) { return r.createdAt >= trainA && r.createdAt < trainB; });
      var test = settled.filter(function (r) { return r.createdAt >= trainB && r.createdAt < testB; });

      var best = null;
      B.GRID.minScore.forEach(function (ms) {
        B.GRID.minRR.forEach(function (mr) {
          var sub = train.filter(function (r) { return r.score.total >= ms && r.levels.netRR1 >= mr; });
          var perf = S.performance(sub);
          if (perf.n < 5) return;
          if (!best || perf.expectancyR > best.perf.expectancyR) best = { minScore: ms, minRR: mr, perf: perf };
        });
      });

      if (!best) {
        results.push({ fold: f + 1, trainFrom: trainA, trainTo: trainB, testTo: testB, skipped: true, reason: 'Fewer than 5 resolved signals in the optimisation window. This engine is selective; it needs a long history before walk-forward folds become meaningful.' });
        continue;
      }
      var testSub = test.filter(function (r) { return r.score.total >= best.minScore && r.levels.netRR1 >= best.minRR; });
      var oos = S.performance(testSub);
      results.push({
        fold: f + 1, trainFrom: trainA, trainTo: trainB, testTo: testB,
        chosen: { minScore: best.minScore, minRR: best.minRR },
        inSample: best.perf, outOfSample: oos
      });
      isAgg = isAgg.concat(train.filter(function (r) { return r.score.total >= best.minScore && r.levels.netRR1 >= best.minRR; }));
      oosAgg = oosAgg.concat(testSub);
    }

    return {
      ok: true,
      symbol: opts.symbol,
      entryTf: tf,
      from: t0, to: t1,
      candlesUsed: entry.length,
      totalCandidates: raw.length,
      settled: settled.length,
      folds: results,
      inSample: S.performance(isAgg),
      outOfSample: S.performance(oosAgg),
      unfiltered: S.performance(settled),
      costsApplied: true,
      newsFilterApplied: false,
      caveats: [
        'No historical economic calendar is available offline, so the news filter was inactive during this run. Live results will differ.',
        'Fills assume the entry zone was reached intrabar; a real broker may not fill at the same price.',
        'When one candle contains both the stop and the target, the run counts a loss.',
        'Out-of-sample numbers describe what already happened. They are not a forecast.'
      ]
    };
  };

})(typeof self !== 'undefined' ? self : this);
