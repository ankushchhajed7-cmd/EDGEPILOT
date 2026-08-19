/* EdgePilot - app.js
 * Wiring. Fetch policy is deliberately frugal: a timeframe is only re-fetched
 * once its next candle has actually closed, which keeps a free data plan alive.
 */
(function () {
  'use strict';
  var EP = window.EP, U = EP.util, E = EP.engine, S = EP.stats, St = EP.store, A = EP.api, UI = EP.ui;

  var state = {
    settings: St.loadSettings(),
    results: [],
    resolved: [],
    allSignals: [],
    weights: null,
    calibration: null,
    riskState: null,
    lastUpdate: null,
    busy: false
  };

  /* ================= data ================= */

  async function getCandles(symbol, tf, outputsize) {
    var tfMs = U.TF_MS[tf];
    var cached = await St.getCandles(symbol, tf);
    var now = Date.now();
    if (cached && cached.candles && cached.candles.length) {
      var lastT = cached.candles[cached.candles.length - 1].t;
      // Re-fetch only once a newer candle could exist.
      if (now < lastT + tfMs * 2) return { candles: cached.candles, fromCache: true, fetchedAt: cached.fetchedAt };
    }
    try {
      var r = await A.ohlc(state.settings, symbol, tf, outputsize);
      await St.putCandles(symbol, tf, r.candles);
      return { candles: r.candles, fromCache: false, fetchedAt: r.fetchedAt };
    } catch (err) {
      if (cached && cached.candles) return { candles: cached.candles, fromCache: true, fetchedAt: cached.fetchedAt, error: err.message };
      throw err;
    }
  }

  var calendarCache = { at: 0, data: null };

  async function getCalendar(symbol) {
    if (Date.now() - calendarCache.at < 15 * 60000 && calendarCache.data) return calendarCache.data;
    try {
      var d = await A.calendar(state.settings, symbol);
      calendarCache = { at: Date.now(), data: d };
      return d;
    } catch (err) {
      return { available: false, reason: 'Calendar request failed: ' + err.message };
    }
  }

  /* ================= scanning ================= */

  async function analyzeSymbol(symbol) {
    var tf = state.settings.entryTf;
    var d1 = await getCandles(symbol, '1day', 260);
    var h4 = await getCandles(symbol, '4h', 300);
    var en = tf === '4h' ? h4 : await getCandles(symbol, tf, 320);

    var cal = await getCalendar(symbol);
    var news = A.newsStatusFor(cal, symbol, Date.now(), state.settings);

    var candles = { '1day': d1.candles, '4h': h4.candles };
    candles[tf] = en.candles;

    var sig = E.analyze({
      symbol: symbol,
      nowMs: Date.now(),
      settings: state.settings,
      candles: candles,
      news: news,
      weights: state.weights,
      riskState: St.computeRiskState(state.allSignals, state.settings, symbol, Date.now())
    });

    sig.history = S.historyFor(sig, state.resolved);
    sig.confidence = S.confidenceFor(sig, state.calibration);
    sig.fetchedAt = Math.min(d1.fetchedAt || Date.now(), h4.fetchedAt || Date.now(), en.fetchedAt || Date.now());
    return sig;
  }

  async function scanAll() {
    if (state.busy) return;
    if (state.settings.dataMode === 'direct') {
      if (!state.settings.twelvedataKey) { UI.setScreen('settings'); UI.toast('Add your TwelveData key first.', true); return; }
    } else if (!state.settings.backendUrl) {
      UI.setScreen('settings'); UI.toast('Add a backend URL first.', true); return;
    }
    state.busy = true;
    setBusy(true);
    var prog = UI.$('scan-progress'), bar = prog.querySelector('.progress-bar');
    prog.hidden = false; bar.style.width = '0%';

    var list = state.settings.instruments.slice();
    var out = [], errors = [];
    for (var i = 0; i < list.length; i++) {
      try {
        var sig = await analyzeSymbol(list[i]);
        out.push(sig);
        if (sig.decision === 'BUY' || sig.decision === 'SELL') await St.saveSignal(sig);
      } catch (err) {
        errors.push(list[i] + ': ' + err.message);
      }
      bar.style.width = Math.round(((i + 1) / list.length) * 100) + '%';
    }
    prog.hidden = true;
    state.results = out;
    state.lastUpdate = Date.now();
    await reloadStats();
    state.busy = false;
    setBusy(false);

    if (errors.length) UI.toast(errors[0], true);
    renderAll();
  }

  function setBusy(b) {
    var r = UI.$('btn-refresh');
    r.setAttribute('aria-busy', b ? 'true' : 'false');
    UI.$('btn-scan').disabled = b;
  }

  /* ================= resolution ================= */

  async function resolveOpen() {
    var pending = await St.pendingSignals();
    if (!pending.length) { UI.toast('No open signals to check.'); return; }
    var done = 0, expired = 0;
    for (var i = 0; i < pending.length; i++) {
      var sg = pending[i];
      try {
        var r = await getCandles(sg.symbol, sg.entryTf, 320);
        var after = r.candles.filter(function (k) { return k.t > sg.createdAt; })
          .sort(function (a, b) { return a.t - b.t; });
        var res = S.resolveSignal(sg, after, state.settings);
        if (res) {
          var rec = Object.assign({}, sg, res, { status: 'RESOLVED' });
          await St.put('signals', rec);
          if (res.outcome === 'EXPIRED_NO_FILL') expired++; else done++;
        }
      } catch (err) { /* leave it pending; the next check will retry */ }
    }
    await reloadStats();
    renderAll();
    UI.toast(done + ' resolved, ' + expired + ' expired without a fill.');
  }

  async function reloadStats() {
    state.allSignals = await St.allSignals();
    state.resolved = state.allSignals.filter(function (r) { return r.outcome; });
    state.weights = S.buildWeights(state.resolved);
    state.calibration = S.calibrate(state.resolved);
    state.riskState = St.computeRiskState(state.allSignals, state.settings, null, Date.now());
  }

  /* ================= render ================= */

  function renderAll() {
    var best = state.results[0];
    var banners = [];
    if (!A.state.online) banners.push({ severity: 'bad', title: 'Offline.', text: 'Showing the last data fetched. Do not act on it.' });
    var staleAny = state.results.some(function (r) { return r.dataQuality && r.dataQuality.status !== 'OK'; });
    if (staleAny) banners.push({ severity: 'bad', title: 'Stale or incomplete data.', text: 'At least one instrument failed the data quality gate. Check the scanner.' });
    if (state.riskState && state.riskState.dailyLossHit) banners.push({ severity: 'bad', title: 'Daily loss limit reached.', text: 'New signals are blocked until tomorrow.' });
    else if (state.riskState && state.riskState.cooldownUntil > Date.now()) banners.push({ severity: 'warn', title: 'Cooldown active.', text: 'Resumes ' + U.fmtTime(state.riskState.cooldownUntil) + '.' });

    UI.renderStatus({
      session: U.sessionAt(Date.now()),
      regime: best && best.regime ? best.regime.display : null,
      lastUpdate: state.lastUpdate,
      stale: staleAny,
      banners: banners
    });

    UI.renderToday(state, handlers);
    UI.renderScan(state, handlers);
    UI.renderLabLive(state.resolved);
    UI.renderCalibration(state.resolved);
    St.allJournal().then(function (j) { UI.renderJournal(state.allSignals, j, handlers); });
  }

  var handlers = {
    onScan: scanAll,
    onOpen: function (sig) {
      UI.renderSignal(sig, {
        aiEnabled: state.settings.aiEnabled,
        onExplain: explainSignal,
        onLog: openLogModal
      });
    }
  };

  /* ================= ai ================= */

  async function explainSignal(sig, slot, btn) {
    btn.disabled = true;
    btn.textContent = 'Requesting explanation…';
    try {
      var res = await A.explain(state.settings, A.factSheet(sig));
      UI.renderAiText(slot, res);
    } catch (err) {
      slot.innerHTML = '';
      var d = document.createElement('div');
      d.className = 'banner bad';
      d.setAttribute('role', 'alert');
      d.textContent = 'Explanation unavailable: ' + err.message;
      slot.appendChild(d);
    }
  }

  /* ================= journal ================= */

  function openLogModal(sig) {
    var body =
      '<div class="field"><label for="jr-action">What did you do</label>' +
      '<select id="jr-action"><option value="TOOK">Took the trade</option>' +
      '<option value="SKIPPED">Skipped it</option>' +
      '<option value="PARTIAL">Took a reduced size</option></select></div>' +
      '<div class="field"><label for="jr-note">Note</label><textarea id="jr-note" maxlength="1000" placeholder="What you saw, what you were feeling, what you would change."></textarea></div>';
    UI.modal('Log to journal', body, [{
      label: 'Save entry', className: 'btn-primary', onClick: async function () {
        var action = UI.$('jr-action').value;
        var note = UI.$('jr-note').value.slice(0, 1000);
        await St.addJournal({ signalId: sig.id, symbol: sig.symbol, action: action, note: note, decision: sig.decision });
        UI.closeModal();
        UI.toast('Saved to the journal.');
        renderAll();
      }
    }]);
  }

  handlers.onOpen2 = null;

  function openJournalDetail(sig, notes) {
    var rows = [
      ['Created', U.fmtTime(sig.createdAt)],
      ['Direction', sig.direction || '--'],
      ['Setup', sig.setup ? sig.setup.label : '--'],
      ['Score', sig.score ? sig.score.total : '--'],
      ['Regime', sig.regime ? sig.regime.primary : '--'],
      ['Session', U.SESSION_LABEL[sig.session]],
      ['News at signal', sig.news ? sig.news.status : '--'],
      ['Entry zone', sig.levels ? U.price(sig.levels.entryLow, sig.symbol) + ' – ' + U.price(sig.levels.entryHigh, sig.symbol) : '--'],
      ['Stop', sig.levels ? U.price(sig.levels.sl, sig.symbol) : '--'],
      ['Target 1', sig.levels ? U.price(sig.levels.tp1, sig.symbol) : '--'],
      ['Target 2', sig.levels ? U.price(sig.levels.tp2, sig.symbol) : '--'],
      ['Outcome', sig.outcome || 'OPEN'],
      ['R multiple', U.isNum(sig.rMultiple) ? sig.rMultiple + 'R' : '--'],
      ['Max favourable', U.isNum(sig.mfeR) ? sig.mfeR + 'R' : '--'],
      ['Max adverse', U.isNum(sig.maeR) ? sig.maeR + 'R' : '--'],
      ['Bars held', sig.barsHeld != null ? sig.barsHeld : '--']
    ];
    if (sig.indicators) {
      Object.keys(sig.indicators).forEach(function (k) {
        rows.push([k, U.isNum(sig.indicators[k]) ? U.round(sig.indicators[k], 5) : String(sig.indicators[k])]);
      });
    }
    var html = '<table class="levels"><tbody>' + rows.map(function (r) {
      return '<tr><th>' + U.esc(r[0]) + '</th><td>' + U.esc(r[1]) + '</td></tr>';
    }).join('') + '</tbody></table>';
    if (sig.note) html += '<p class="note">' + U.esc(sig.note) + '</p>';
    if (notes && notes.length) {
      html += '<div class="eyebrow" style="margin-top:14px">Your notes</div><ul class="reasons">' +
        notes.map(function (j) { return '<li>' + U.esc(U.fmtTime(j.createdAt) + ' · ' + j.action + ' · ' + (j.note || '')) + '</li>'; }).join('') + '</ul>';
    }
    UI.modal(sig.symbol + ' ' + (sig.direction || ''), html, [
      { label: 'Add a note', onClick: function () { UI.closeModal(); openLogModal(sig); } }
    ]);
  }

  /* ================= settings ================= */

  function applyMode(mode) {
    UI.$('mode-backend').hidden = (mode === 'direct');
    UI.$('mode-direct').hidden = (mode !== 'direct');
  }

  function renderSettings() {
    var s = state.settings;
    UI.$('set-mode').value = s.dataMode || 'backend';
    UI.$('set-backend').value = s.backendUrl || '';
    UI.$('set-tdkey').value = s.twelvedataKey || '';
    applyMode(s.dataMode || 'backend');
    UI.$('set-tf').value = s.entryTf;
    UI.$('set-balance').value = s.accountBalance;
    UI.$('set-risk').value = s.riskPercent;
    UI.$('set-minrr').value = s.minRR;
    UI.$('set-minscore').value = s.minScore;
    UI.$('set-dll').value = s.dailyLossLimitR;
    UI.$('set-cooldown').value = s.cooldownLosses;
    UI.$('set-lowliq').checked = !!s.allowLowLiquidity;
    UI.$('set-highvol').checked = !!s.allowHighVol;
    UI.$('set-counter').checked = !!s.allowCounterBiasRangeReversal;
    UI.$('set-ai').checked = !!s.aiEnabled;

    var box = UI.$('set-instruments');
    box.innerHTML = U.INSTRUMENTS.map(function (i) {
      var on = s.instruments.indexOf(i.id) >= 0;
      var id = 'ins-' + i.id.replace('/', '');
      return '<label class="check-pill"><input type="checkbox" id="' + id + '" value="' + U.esc(i.id) + '"' +
        (on ? ' checked' : '') + '><span>' + U.esc(i.label) + (i.optional ? ' *' : '') + '</span></label>';
    }).join('');

    var costs = UI.$('set-costs');
    costs.innerHTML = U.INSTRUMENTS.map(function (i) {
      var c = (s.costs || {})[i.id] || {};
      var sp = c.spread != null ? c.spread : i.defaultSpread;
      var cm = c.commissionPerLot != null ? c.commissionPerLot : 7;
      var k = i.id.replace('/', '');
      return '<div class="cost-row"><span class="sym">' + U.esc(i.label) + '</span>' +
        '<input type="number" step="any" min="0" id="sp-' + k + '" aria-label="Spread for ' + U.esc(i.label) + '" value="' + U.esc(sp) + '">' +
        '<input type="number" step="any" min="0" id="cm-' + k + '" aria-label="Commission per lot for ' + U.esc(i.label) + '" value="' + U.esc(cm) + '"></div>';
    }).join('');
    costs.insertAdjacentHTML('afterbegin', '<div class="cost-row"><span class="sym eyebrow">pair</span><span class="eyebrow">spread</span><span class="eyebrow">comm/lot</span></div>');
  }

  function collectSettings() {
    var s = Object.assign({}, state.settings);
    s.dataMode = UI.$('set-mode').value === 'direct' ? 'direct' : 'backend';
    s.backendUrl = UI.$('set-backend').value.trim();
    s.twelvedataKey = UI.$('set-tdkey').value.trim();
    s.entryTf = UI.$('set-tf').value;
    s.accountBalance = Math.max(1, Number(UI.$('set-balance').value) || 1000);
    s.riskPercent = U.clamp(Number(UI.$('set-risk').value) || 0.5, 0.05, 5);
    s.minRR = U.clamp(Number(UI.$('set-minrr').value) || 1.5, 1, 5);
    s.minScore = U.clamp(Number(UI.$('set-minscore').value) || 62, 0, 100);
    s.dailyLossLimitR = U.clamp(Number(UI.$('set-dll').value) || 2, 0.5, 10);
    s.cooldownLosses = U.clamp(Number(UI.$('set-cooldown').value) || 3, 2, 10);
    s.allowLowLiquidity = UI.$('set-lowliq').checked;
    s.allowHighVol = UI.$('set-highvol').checked;
    s.allowCounterBiasRangeReversal = UI.$('set-counter').checked;
    s.aiEnabled = UI.$('set-ai').checked;

    s.instruments = Array.prototype.slice.call(UI.$('set-instruments').querySelectorAll('input:checked'))
      .map(function (i) { return i.value; });
    if (!s.instruments.length) s.instruments = ['XAU/USD'];

    s.costs = {};
    U.INSTRUMENTS.forEach(function (i) {
      var k = i.id.replace('/', '');
      var sp = Number(UI.$('sp-' + k).value), cm = Number(UI.$('cm-' + k).value);
      s.costs[i.id] = {
        spread: U.isNum(sp) && sp >= 0 ? sp : i.defaultSpread,
        commissionPerLot: U.isNum(cm) && cm >= 0 ? cm : 7,
        slippage: (U.isNum(sp) ? sp : i.defaultSpread) * 0.5
      };
    });
    return s;
  }

  function saveSettings() {
    state.settings = collectSettings();
    var stripped = St.saveSettings(state.settings);
    if (stripped.length) UI.toast('Refused to store fields that look like credentials: ' + stripped.join(', '), true);
    fillBacktestSymbols();
    renderAll();
  }

  /* ================= backtest ================= */

  function fillBacktestSymbols() {
    var sel = UI.$('bt-symbol');
    sel.innerHTML = state.settings.instruments.map(function (i) {
      return '<option value="' + U.esc(i) + '">' + U.esc(i) + '</option>';
    }).join('');
  }

  async function runBacktest() {
    var symbol = UI.$('bt-symbol').value;
    if (!symbol) return;
    var btn = UI.$('btn-backtest');
    var prog = UI.$('bt-progress'), bar = prog.querySelector('.progress-bar');
    btn.disabled = true; prog.hidden = false; bar.style.width = '0%';
    UI.renderBacktest(null);
    try {
      var tf = state.settings.entryTf;
      var d1 = await getCandles(symbol, '1day', 400);
      var h4 = await getCandles(symbol, '4h', 800);
      var en = tf === '4h' ? h4 : await getCandles(symbol, tf, 2000);
      var candles = { '1day': d1.candles, '4h': h4.candles };
      candles[tf] = en.candles;

      var res = await EP.backtest.run({
        symbol: symbol, candles: candles, settings: state.settings, folds: 4,
        onProgress: function (p) { bar.style.width = Math.round(p * 100) + '%'; }
      });
      UI.renderBacktest(res);
    } catch (err) {
      UI.renderBacktest({ ok: false, error: err.message });
    } finally {
      btn.disabled = false; prog.hidden = true;
    }
  }

  /* ================= backup ================= */

  async function exportBackup() {
    var data = await St.exportBackup();
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'edgepilot-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    UI.toast('Backup exported. It contains no credentials.');
  }

  function importBackup(file) {
    if (file.size > 12 * 1024 * 1024) { UI.toast('That file is too large to import.', true); return; }
    var fr = new FileReader();
    fr.onload = function () {
      var parsed;
      try { parsed = JSON.parse(fr.result); }
      catch (err) { UI.toast('That file is not valid JSON.', true); return; }
      var v = St.validateBackup(parsed);
      if (!v.ok) { UI.toast('Import rejected: ' + v.errors[0], true); return; }
      var msg = '<p class="note">' + v.signals.length + ' signals and ' + v.journal.length + ' journal entries passed validation.' +
        (v.rejected.signals + v.rejected.journal ? ' ' + (v.rejected.signals + v.rejected.journal) + ' malformed records were discarded.' : '') +
        (v.secretsStripped.length ? ' Credential-looking fields were stripped: ' + U.esc(v.secretsStripped.join(', ')) + '.' : '') + '</p>';
      UI.modal('Import backup', msg, [
        { label: 'Merge into existing data', className: 'btn-primary', onClick: async function () { await St.importBackup(v, 'merge'); UI.closeModal(); await reloadStats(); renderAll(); UI.toast('Imported.'); } },
        { label: 'Replace everything', className: 'btn-danger', onClick: async function () { await St.importBackup(v, 'replace'); UI.closeModal(); await reloadStats(); renderAll(); UI.toast('Replaced.'); } }
      ]);
    };
    fr.readAsText(file);
  }

  /* ================= wiring ================= */

  function wire() {
    ['today', 'scan', 'lab', 'journal', 'settings'].forEach(function (s) {
      UI.$('tab-' + s).addEventListener('click', function () { UI.setScreen(s); });
    });
    UI.$('btn-back').addEventListener('click', function () { UI.setScreen('scan'); });
    UI.$('btn-refresh').addEventListener('click', scanAll);
    UI.$('btn-scan').addEventListener('click', scanAll);
    UI.$('btn-resolve').addEventListener('click', resolveOpen);
    UI.$('btn-export').addEventListener('click', exportBackup);
    UI.$('btn-import').addEventListener('click', function () { UI.$('file-import').click(); });
    UI.$('file-import').addEventListener('change', function (ev) {
      if (ev.target.files && ev.target.files[0]) importBackup(ev.target.files[0]);
      ev.target.value = '';
    });
    UI.$('btn-backtest').addEventListener('click', runBacktest);

    var labTabs = [['lab-tab-live', 'lab-live'], ['lab-tab-cal', 'lab-cal'], ['lab-tab-bt', 'lab-bt']];
    labTabs.forEach(function (pair) {
      UI.$(pair[0]).addEventListener('click', function () {
        labTabs.forEach(function (p) {
          var active = p[0] === pair[0];
          UI.$(p[0]).classList.toggle('is-active', active);
          UI.$(p[0]).setAttribute('aria-selected', active ? 'true' : 'false');
          UI.$(p[1]).hidden = !active;
        });
      });
    });

    ['set-backend', 'set-tf', 'set-balance', 'set-risk', 'set-minrr', 'set-minscore', 'set-dll', 'set-cooldown',
      'set-lowliq', 'set-highvol', 'set-counter', 'set-ai', 'set-mode', 'set-tdkey'].forEach(function (id) {
      UI.$(id).addEventListener('change', saveSettings);
    });
    UI.$('set-mode').addEventListener('change', function () { applyMode(UI.$('set-mode').value); });
    UI.$('set-instruments').addEventListener('change', saveSettings);
    UI.$('set-costs').addEventListener('change', saveSettings);

    UI.$('btn-health').addEventListener('click', async function () {
      var out = UI.$('health-result');
      out.textContent = 'Testing…';
      var r = await A.health(state.settings);
      out.innerHTML = r.ok
        ? '<div class="banner" role="status"><strong>Connected.</strong><span>' +
          U.esc('Market data: ' + (r.providers.marketData || 'unknown') +
            '. Calendar: ' + (r.providers.calendar || 'not configured') +
            '. AI: ' + (r.providers.ai || 'not configured') + '.' +
            (r.note ? ' ' + r.note : '')) + '</span></div>'
        : '<div class="banner bad" role="alert"><strong>Not reachable.</strong><span>' + U.esc(r.error) + '</span></div>';
    });

    UI.$('btn-clear-cache').addEventListener('click', async function () {
      await St.clear('candles');
      UI.toast('Candle cache cleared. The next scan will refetch.');
    });

    UI.$('btn-wipe').addEventListener('click', function () {
      UI.modal('Erase everything', '<p class="note">This deletes every stored signal and journal entry on this device. Your live performance record and calibration restart from zero. Export a backup first if you want to keep it.</p>', [
        { label: 'Erase permanently', className: 'btn-danger', onClick: async function () {
          await St.clear('signals'); await St.clear('journal');
          UI.closeModal(); await reloadStats(); state.results = []; renderAll(); UI.toast('Erased.');
        } }
      ]);
    });

    handlers.onOpen = function (sig, notes) {
      if (notes !== undefined) openJournalDetail(sig, notes);
      else UI.renderSignal(sig, { aiEnabled: state.settings.aiEnabled, onExplain: explainSignal, onLog: openLogModal });
    };

    window.addEventListener('online', renderAll);
    window.addEventListener('offline', renderAll);
  }

  /* ================= install ================= */

  var deferredPrompt = null;

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function setupInstall() {
    var card = UI.$('install-card'), btn = UI.$('btn-install'), hint = UI.$('install-hint');

    if (isStandalone()) {
      card.hidden = false;
      btn.hidden = true;
      hint.textContent = 'EdgePilot is already installed and running as an app.';
      return;
    }

    var ua = navigator.userAgent;
    var isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;

    if (isIOS) {
      // Safari never fires beforeinstallprompt, so the only honest thing is to
      // describe the manual steps rather than show a button that does nothing.
      card.hidden = false;
      btn.hidden = true;
      hint.textContent = 'On iPhone: tap the Share button in Safari, then "Add to Home Screen". Chrome on iOS cannot install web apps.';
      return;
    }

    window.addEventListener('beforeinstallprompt', function (ev) {
      ev.preventDefault();
      deferredPrompt = ev;
      card.hidden = false;
      btn.hidden = false;
      hint.textContent = '';
    });

    btn.addEventListener('click', async function () {
      if (!deferredPrompt) {
        hint.textContent = 'Your browser did not offer an install prompt. Open the browser menu and choose "Install app" or "Add to Home screen".';
        return;
      }
      deferredPrompt.prompt();
      var res = await deferredPrompt.userChoice;
      deferredPrompt = null;
      if (res.outcome === 'accepted') { UI.toast('Installing EdgePilot.'); btn.hidden = true; }
      else hint.textContent = 'Install dismissed. You can start it again from the browser menu.';
    });

    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      btn.hidden = true;
      hint.textContent = 'Installed. Open EdgePilot from your home screen from now on.';
      UI.toast('EdgePilot installed.');
    });
  }

  /* ================= boot ================= */

  async function boot() {
    wire();
    setupInstall();
    renderSettings();
    fillBacktestSymbols();
    await reloadStats();
    renderAll();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline shell is optional */ });
    }
    var configured = state.settings.dataMode === 'direct'
      ? !!state.settings.twelvedataKey
      : !!state.settings.backendUrl;
    if (configured) {
      var h = await A.health(state.settings);
      if (!h.ok) UI.toast('Data source not reachable: ' + h.error, true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
