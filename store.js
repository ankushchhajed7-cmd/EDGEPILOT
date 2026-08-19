/* EdgePilot - store.js
 * IndexedDB for signals / journal / candle cache. localStorage holds settings only,
 * and every write is passed through a stripper that refuses secret-looking fields.
 */
(function (root) {
  'use strict';
  var EP = root.EP = root.EP || {};
  var U = EP.util;
  var St = EP.store = {};

  var DB_NAME = 'edgepilot', DB_VER = 1, dbp = null;
  var SETTINGS_KEY = 'ep.settings.v1';

  /* ================= settings ================= */

  St.DEFAULTS = {
    backendUrl: '',
    entryTf: '1h',
    instruments: ['XAU/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD'],
    accountBalance: 1000,
    riskPercent: 0.5,
    minRR: 1.5,
    minScore: 62,
    minStopAtr: 0.8,
    maxStopAtr: 3.0,
    maxSpreadAtr: 0.15,
    maxCandleAtr: 2.0,
    adxTrend: 22,
    adxRange: 18,
    expiryBars: 12,
    maxTargetR1: 3.0,
    maxTargetR2: 5.0,
    holdBars: 24,
    staleFactorTf: 2.5,
    newsBlackoutMin: 30,
    newsNearMin: 120,
    allowLowLiquidity: false,
    allowHighVol: false,
    allowCounterBiasRangeReversal: false,
    maxOpenPerSymbol: 1,
    dailyLossLimitR: 2,
    cooldownLosses: 3,
    cooldownHours: 12,
    aiEnabled: false,
    theme: 'graphite',
    costs: {}
  };

  // Anything that smells like a credential is refused at the storage boundary,
  // so a future careless edit cannot quietly start persisting secrets.
  var SECRET_RE = /(key|token|secret|password|passwd|credential|apikey|bearer|auth|upi|qr)/i;

  St.stripSecrets = function (obj, found) {
    found = found || [];
    if (obj == null || typeof obj !== 'object') return { value: obj, found: found };
    var out = Array.isArray(obj) ? [] : {};
    Object.keys(obj).forEach(function (k) {
      if (SECRET_RE.test(k)) { found.push(k); return; }
      var r = St.stripSecrets(obj[k], found);
      out[k] = r.value;
    });
    return { value: out, found: found };
  };

  St.loadSettings = function () {
    var s = Object.assign({}, St.DEFAULTS);
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        var clean = St.stripSecrets(parsed).value;
        Object.keys(St.DEFAULTS).forEach(function (k) {
          if (clean[k] !== undefined) s[k] = clean[k];
        });
      }
    } catch (e) { /* corrupted settings fall back to defaults */ }
    if (!U.TF_MS[s.entryTf]) s.entryTf = '1h';
    s.instruments = (s.instruments || []).filter(function (id) { return !!U.instrument(id); });
    if (!s.instruments.length) s.instruments = St.DEFAULTS.instruments.slice();
    return s;
  };

  St.saveSettings = function (s) {
    var r = St.stripSecrets(s);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(r.value));
    return r.found;
  };

  /* ================= indexeddb ================= */

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('signals')) {
          var s = db.createObjectStore('signals', { keyPath: 'id' });
          s.createIndex('symbol', 'symbol');
          s.createIndex('createdAt', 'createdAt');
          s.createIndex('status', 'status');
        }
        if (!db.objectStoreNames.contains('journal')) {
          var j = db.createObjectStore('journal', { keyPath: 'id' });
          j.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('candles')) db.createObjectStore('candles', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error); };
    });
    return dbp;
  }

  function tx(storeName, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(storeName, mode);
        var st = t.objectStore(storeName);
        var out = fn(st);
        t.oncomplete = function () { res(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error); };
      });
    });
  }

  St.put = function (store, value) { return tx(store, 'readwrite', function (s) { return s.put(value); }); };
  St.del = function (store, key) { return tx(store, 'readwrite', function (s) { return s.delete(key); }); };
  St.get = function (store, key) { return tx(store, 'readonly', function (s) { return s.get(key); }); };
  St.all = function (store) { return tx(store, 'readonly', function (s) { return s.getAll(); }); };
  St.clear = function (store) { return tx(store, 'readwrite', function (s) { return s.clear(); }); };

  /* ================= candle cache ================= */

  St.cacheKey = function (symbol, tf) { return symbol + '|' + tf; };

  St.getCandles = function (symbol, tf) {
    return St.get('candles', St.cacheKey(symbol, tf)).then(function (r) { return r || null; });
  };

  St.putCandles = function (symbol, tf, candles) {
    return St.put('candles', {
      key: St.cacheKey(symbol, tf), symbol: symbol, tf: tf,
      fetchedAt: Date.now(), candles: candles
    });
  };

  /* ================= signals ================= */

  St.saveSignal = function (sig) {
    var rec = Object.assign({}, sig);
    rec.status = rec.outcome ? 'RESOLVED' : (rec.decision === 'BUY' || rec.decision === 'SELL' ? 'PENDING' : 'INFO');
    return St.put('signals', rec).then(function () { return rec; });
  };

  St.allSignals = function () { return St.all('signals'); };

  St.resolvedSignals = function () {
    return St.all('signals').then(function (all) {
      return (all || []).filter(function (r) { return r.outcome; });
    });
  };

  St.pendingSignals = function () {
    return St.all('signals').then(function (all) {
      return (all || []).filter(function (r) { return r.status === 'PENDING' && !r.outcome; });
    });
  };

  /* ================= risk state ================= */

  St.computeRiskState = function (allSignals, settings, symbol, nowMs) {
    var dayStart = new Date(nowMs); dayStart.setUTCHours(0, 0, 0, 0);
    var todayR = 0, recentLosses = 0, lastLossAt = 0, openForSymbol = 0;
    var resolved = (allSignals || []).filter(function (r) { return r.outcome && U.isNum(r.rMultiple); })
      .sort(function (a, b) { return a.resolvedAt - b.resolvedAt; });

    resolved.forEach(function (r) { if (r.resolvedAt >= dayStart.getTime()) todayR += r.rMultiple; });

    for (var i = resolved.length - 1; i >= 0; i--) {
      if (resolved[i].rMultiple < 0) { recentLosses++; lastLossAt = Math.max(lastLossAt, resolved[i].resolvedAt); }
      else break;
    }
    (allSignals || []).forEach(function (r) {
      if (r.symbol === symbol && r.status === 'PENDING' && !r.outcome) openForSymbol++;
    });

    var cooldownUntil = 0;
    if (recentLosses >= (settings.cooldownLosses || 3) && lastLossAt) {
      cooldownUntil = lastLossAt + (settings.cooldownHours || 12) * 3600000;
    }
    return {
      todayR: U.round(todayR, 2),
      dailyLossHit: todayR <= -Math.abs(settings.dailyLossLimitR || 2),
      consecutiveLosses: recentLosses,
      cooldownUntil: cooldownUntil,
      openForSymbol: openForSymbol
    };
  };

  /* ================= journal ================= */

  St.addJournal = function (entry) {
    var e = Object.assign({ id: U.id('jr'), createdAt: Date.now() }, entry);
    return St.put('journal', e).then(function () { return e; });
  };

  St.allJournal = function () { return St.all('journal'); };

  /* ================= backup ================= */

  St.exportBackup = async function () {
    var signals = await St.all('signals');
    var journal = await St.all('journal');
    var settings = St.stripSecrets(St.loadSettings()).value;
    delete settings.backendUrl; // an endpoint is not a secret, but it is not yours to hand out either
    return {
      format: 'edgepilot.backup', version: 1, exportedAt: new Date().toISOString(),
      counts: { signals: signals.length, journal: journal.length },
      settings: settings, signals: signals, journal: journal
    };
  };

  // Imports are treated as hostile input until proven otherwise.
  St.validateBackup = function (obj) {
    var errors = [];
    if (!obj || typeof obj !== 'object') return { ok: false, errors: ['File is not a JSON object.'] };
    if (obj.format !== 'edgepilot.backup') errors.push('Missing the edgepilot.backup format marker.');
    if (obj.version !== 1) errors.push('Unsupported backup version.');
    if (!Array.isArray(obj.signals)) errors.push('signals must be an array.');
    if (!Array.isArray(obj.journal)) errors.push('journal must be an array.');
    if (errors.length) return { ok: false, errors: errors };

    if (obj.signals.length > 20000 || obj.journal.length > 20000) return { ok: false, errors: ['Backup is too large to import safely.'] };

    var goodSignals = [], badSignals = 0;
    obj.signals.forEach(function (r) {
      if (!r || typeof r.id !== 'string' || !U.isNum(r.createdAt) || typeof r.symbol !== 'string') { badSignals++; return; }
      if (!U.instrument(r.symbol)) { badSignals++; return; }
      if (r.rMultiple != null && !U.isNum(r.rMultiple)) { badSignals++; return; }
      goodSignals.push(St.stripSecrets(r).value);
    });
    var goodJournal = [], badJournal = 0;
    obj.journal.forEach(function (r) {
      if (!r || typeof r.id !== 'string' || !U.isNum(r.createdAt)) { badJournal++; return; }
      goodJournal.push(St.stripSecrets(r).value);
    });

    var secretsFound = St.stripSecrets(obj).found;
    return {
      ok: true, signals: goodSignals, journal: goodJournal,
      rejected: { signals: badSignals, journal: badJournal },
      secretsStripped: secretsFound
    };
  };

  St.importBackup = async function (validated, mode) {
    if (mode === 'replace') { await St.clear('signals'); await St.clear('journal'); }
    for (var i = 0; i < validated.signals.length; i++) await St.put('signals', validated.signals[i]);
    for (var j = 0; j < validated.journal.length; j++) await St.put('journal', validated.journal[j]);
    return { signals: validated.signals.length, journal: validated.journal.length };
  };

})(typeof self !== 'undefined' ? self : this);
