/* EdgePilot - api.js
 * Thin client for the EdgePilot backend. The app never sees a provider key:
 * it only knows a backend URL, which is not a credential.
 */
(function (root) {
  'use strict';
  var EP = root.EP = root.EP || {};
  var U = EP.util;
  var A = EP.api = {};

  A.state = { online: navigator.onLine, lastError: null, backendOk: null };

  function base(settings) {
    var b = (settings.backendUrl || '').trim().replace(/\/+$/, '');
    if (!b) throw new A.ConfigError('No backend URL is configured. Open Settings and add the address of your EdgePilot backend.');
    if (!/^https:\/\//i.test(b) && !/^http:\/\/localhost/i.test(b)) {
      throw new A.ConfigError('The backend URL must use https.');
    }
    return b;
  }

  A.ConfigError = function (msg) { this.name = 'ConfigError'; this.message = msg; };
  A.ConfigError.prototype = Object.create(Error.prototype);

  async function req(settings, path, opts) {
    var url = base(settings) + path;
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, (opts && opts.timeoutMs) || 20000);
    try {
      var r = await fetch(url, {
        method: (opts && opts.method) || 'GET',
        headers: Object.assign({ 'Accept': 'application/json' }, (opts && opts.body) ? { 'Content-Type': 'application/json' } : {}),
        body: (opts && opts.body) ? JSON.stringify(opts.body) : undefined,
        signal: ctl.signal,
        cache: 'no-store'
      });
      var text = await r.text();
      var data;
      try { data = JSON.parse(text); }
      catch (e) { throw new Error('Backend returned a non-JSON response (HTTP ' + r.status + ').'); }
      if (!r.ok) throw new Error(data && data.error ? String(data.error).slice(0, 300) : 'Backend error HTTP ' + r.status + '.');
      return data;
    } finally { clearTimeout(timer); }
  }

  A.health = async function (settings) {
    if (settings.dataMode === 'direct') {
      try {
        var probe = await A.ohlcDirect(settings, 'EUR/USD', '1h', 5);
        A.state.backendOk = true;
        return {
          ok: true,
          providers: { marketData: 'twelvedata (direct)', calendar: null, ai: null },
          serverTime: Date.now(),
          note: probe.candles.length + ' closed candles returned.'
        };
      } catch (e) {
        A.state.backendOk = false;
        return { ok: false, error: e.message };
      }
    }
    try {
      var d = await req(settings, '/health', { timeoutMs: 8000 });
      A.state.backendOk = true;
      return { ok: true, providers: d.providers || {}, serverTime: d.serverTime };
    } catch (e) {
      A.state.backendOk = false;
      return { ok: false, error: e.message };
    }
  };

  /**
   * Candles are returned oldest-first as {t,o,h,l,c,v}. The backend must not
   * return a still-forming candle, but the engine re-checks anyway.
   */
  var TD_INTERVAL = { '15min': '15min', '1h': '1h', '4h': '4h', '1day': '1day' };

  /**
   * Direct mode. The browser talks to TwelveData itself, so the key is present
   * in this page and anyone with the page can read it. Kept as an explicit
   * opt-in, never the default.
   */
  A.ohlcDirect = async function (settings, symbol, interval, outputsize) {
    var key = (settings.twelvedataKey || '').trim();
    if (!key) throw new A.ConfigError('No TwelveData key is set. Open Settings and add one, or switch back to backend mode.');
    if (!TD_INTERVAL[interval]) throw new Error('Unsupported interval ' + interval + '.');

    var u = 'https://api.twelvedata.com/time_series' +
      '?symbol=' + encodeURIComponent(symbol) +
      '&interval=' + TD_INTERVAL[interval] +
      '&outputsize=' + encodeURIComponent(outputsize || 300) +
      '&timezone=UTC&order=ASC&apikey=' + encodeURIComponent(key);

    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 20000);
    var d;
    try {
      var r = await fetch(u, { signal: ctl.signal, cache: 'no-store' });
      d = await r.json();
    } catch (err) {
      throw new Error('Could not reach TwelveData: ' + err.message);
    } finally { clearTimeout(timer); }

    if (!d || !Array.isArray(d.values)) {
      throw new Error(String((d && d.message) || 'TwelveData returned no series').slice(0, 250));
    }

    var nowMs = Date.now(), tfMs = U.TF_MS[interval], out = [];
    for (var i = 0; i < d.values.length; i++) {
      var v = d.values[i];
      var t = Date.parse(String(v.datetime).replace(' ', 'T') + 'Z');
      if (!U.isNum(t)) continue;
      if (t + tfMs > nowMs) continue; // drop the candle that is still forming
      var o = +v.open, h = +v.high, l = +v.low, c = +v.close;
      if (!U.isNum(o) || !U.isNum(h) || !U.isNum(l) || !U.isNum(c)) continue;
      out.push({ t: t, o: o, h: h, l: l, c: c, v: v.volume != null ? +v.volume : null });
    }
    out.sort(function (a, b) { return a.t - b.t; });
    return { candles: out, provider: 'twelvedata (direct)', cached: false, fetchedAt: Date.now() };
  };

  A.ohlcBackend = async function (settings, symbol, interval, outputsize) {
    var q = '?symbol=' + encodeURIComponent(symbol) +
      '&interval=' + encodeURIComponent(interval) +
      '&outputsize=' + encodeURIComponent(outputsize || 300);
    var d = await req(settings, '/ohlc' + q);
    if (!d || !Array.isArray(d.candles)) throw new Error('Backend returned no candles for ' + symbol + ' ' + interval + '.');
    return {
      candles: d.candles.filter(function (k) {
        return U.isNum(k.t) && U.isNum(k.o) && U.isNum(k.h) && U.isNum(k.l) && U.isNum(k.c);
      }),
      provider: d.provider, cached: !!d.cached, fetchedAt: d.fetchedAt || Date.now()
    };
  };

  /**
   * Economic calendar. If the backend has no feed configured it must say so
   * rather than returning an empty list, because "no events" and "no data" are
   * completely different risk positions.
   */
  A.ohlc = function (settings, symbol, interval, outputsize) {
    return settings.dataMode === 'direct'
      ? A.ohlcDirect(settings, symbol, interval, outputsize)
      : A.ohlcBackend(settings, symbol, interval, outputsize);
  };

  A.calendarBackend = async function (settings, symbol) {
    var d = await req(settings, '/calendar?symbol=' + encodeURIComponent(symbol), { timeoutMs: 12000 });
    return d;
  };

  A.calendar = function (settings, symbol) {
    if (settings.dataMode === 'direct') {
      // No calendar provider is reachable without a backend, and "no feed" is
      // not the same as "no events". Report it as unverified.
      return Promise.resolve({
        available: false,
        reason: 'Direct mode has no economic calendar. News risk is unverified, not cleared.'
      });
    }
    return A.calendarBackend(settings, symbol);
  };

  A.newsStatusFor = function (calendar, symbol, nowMs, settings) {
    if (!calendar || calendar.available === false) {
      return { status: 'UNKNOWN', events: [], minutesToNext: null, source: (calendar && calendar.reason) || 'No calendar feed configured on the backend.' };
    }
    var inst = U.instrument(symbol) || {};
    var ccys = symbol.split('/');
    if (inst.kind === 'metal') ccys = ['USD'];
    if (inst.kind === 'crypto') ccys = ['USD'];
    var evs = (calendar.events || []).filter(function (e) {
      return e && U.isNum(e.time) && String(e.impact).toUpperCase() === 'HIGH' && ccys.indexOf(String(e.currency).toUpperCase()) >= 0;
    }).sort(function (a, b) { return Math.abs(a.time - nowMs) - Math.abs(b.time - nowMs); });

    if (!evs.length) return { status: 'CLEAR', events: [], minutesToNext: null, source: calendar.source || 'backend calendar' };
    var mins = Math.round((evs[0].time - nowMs) / 60000);
    var abs = Math.abs(mins);
    var status = abs <= (settings.newsBlackoutMin || 30) ? 'IMMINENT'
      : (mins > 0 && mins <= (settings.newsNearMin || 120) ? 'NEAR' : 'CLEAR');
    return {
      status: status, minutesToNext: mins,
      events: evs.slice(0, 5).map(function (e) {
        return { time: e.time, currency: String(e.currency).slice(0, 8), title: String(e.title || '').slice(0, 120), impact: 'HIGH' };
      }),
      source: calendar.source || 'backend calendar'
    };
  };

  /**
   * AI explanation. Only a fact sheet the engine already computed is sent.
   * The backend adds a system prompt that forbids inventing anything and the
   * response is escaped before it touches the DOM.
   */
  A.explain = async function (settings, factSheet) {
    if (settings.dataMode === 'direct') {
      throw new Error('AI explanations need a backend. Direct mode only fetches market data.');
    }
    var d = await req(settings, '/ai/explain', { method: 'POST', body: { facts: factSheet }, timeoutMs: 30000 });
    if (!d || typeof d.text !== 'string') throw new Error('AI backend returned no text.');
    return { text: d.text.slice(0, 4000), model: d.model, disclaimer: d.disclaimer };
  };

  A.factSheet = function (sig) {
    // Deliberately narrow. If a number is not in here, the model has no basis
    // to state it, and the prompt tells it to say so instead of guessing.
    var f = {
      symbol: sig.symbol,
      timeframe: U.TF_LABEL[sig.entryTf],
      decision: sig.decision,
      session: sig.session,
      regime: sig.regime ? sig.regime.display : null,
      regimeDetail: sig.regime ? sig.regime.detail : null,
      biasD1: sig.bias ? sig.bias.d1.dir : null,
      biasH4: sig.bias ? sig.bias.h4.dir : null,
      setup: sig.setup ? sig.setup.label : null,
      setupNotes: sig.setup ? sig.setup.notes : null,
      gates: (sig.gates || []).map(function (g) { return g.n + ' ' + g.label + ': ' + g.status; }),
      failedAt: sig.failedAt,
      reasonsPass: sig.reasons ? sig.reasons.pass : [],
      reasonsFail: sig.reasons ? sig.reasons.fail : [],
      reasonsWarn: sig.reasons ? sig.reasons.warn : [],
      newsStatus: sig.news ? sig.news.status : 'UNKNOWN'
    };
    if (sig.levels) {
      f.entryZone = [U.price(sig.levels.entryLow, sig.symbol), U.price(sig.levels.entryHigh, sig.symbol)];
      f.stopLoss = U.price(sig.levels.sl, sig.symbol);
      f.target1 = U.price(sig.levels.tp1, sig.symbol);
      f.target2 = U.price(sig.levels.tp2, sig.symbol);
      f.netRewardRisk = U.round(sig.levels.netRR1, 2);
      f.stopInAtr = U.round(sig.levels.stopAtr, 2);
    }
    if (sig.score) { f.setupScore = sig.score.total; f.scoreGroups = sig.score.groups; }
    if (sig.confidence && sig.confidence.available) {
      f.calibratedWinRate = U.pct(sig.confidence.value);
      f.calibrationSample = sig.confidence.n;
    } else {
      f.calibratedWinRate = 'not available - insufficient resolved sample';
    }
    if (sig.history && sig.history.available) {
      f.historicalWinRate = U.pct(sig.history.winRate);
      f.historicalSample = sig.history.n;
      f.historicalScope = sig.history.label;
    } else {
      f.historicalWinRate = 'not available - insufficient resolved sample';
    }
    return f;
  };

  root.addEventListener('online', function () { A.state.online = true; });
  root.addEventListener('offline', function () { A.state.online = false; });

})(typeof self !== 'undefined' ? self : this);
