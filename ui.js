/* EdgePilot - ui.js
 * All rendering. Every value that reaches innerHTML has passed through esc().
 */
(function (root) {
  'use strict';
  var EP = root.EP = root.EP || {};
  var U = EP.util, E = EP.engine, S = EP.stats;
  var UI = EP.ui = {};

  var e = U.esc;
  function $(id) { return document.getElementById(id); }
  UI.$ = $;

  /* ---------- toast ---------- */

  UI.toast = function (msg, bad) {
    var wrap = $('toast-root');
    var t = document.createElement('div');
    t.className = 'toast' + (bad ? ' bad' : '');
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(function () { t.remove(); }, 4200);
  };

  /* ---------- modal ---------- */

  var lastFocus = null;

  UI.modal = function (title, bodyHtml, actions) {
    UI.closeModal();
    lastFocus = document.activeElement;
    var root_ = $('modal-root');
    var bd = document.createElement('div');
    bd.className = 'modal-backdrop';
    bd.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">' +
      '<button class="btn btn-ghost modal-close" type="button" data-close>Close</button>' +
      '<h2 id="modal-title">' + e(title) + '</h2>' +
      '<div class="modal-body">' + bodyHtml + '</div>' +
      '<div class="modal-actions"></div></div>';
    root_.appendChild(bd);

    var acts = bd.querySelector('.modal-actions');
    (actions || []).forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ' + (a.className || 'btn-secondary') + ' btn-block';
      b.style.marginTop = '10px';
      b.textContent = a.label;
      b.addEventListener('click', function () { a.onClick && a.onClick(); });
      acts.appendChild(b);
    });

    bd.addEventListener('click', function (ev) {
      if (ev.target === bd || ev.target.hasAttribute('data-close')) UI.closeModal();
    });

    // Focus trap + escape.
    var focusables = function () {
      return Array.prototype.slice.call(bd.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter(function (n) { return !n.disabled && n.offsetParent !== null; });
    };
    bd.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); UI.closeModal(); return; }
      if (ev.key !== 'Tab') return;
      var f = focusables();
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    });
    var f0 = focusables();
    if (f0.length) f0[0].focus();
    return bd;
  };

  UI.closeModal = function () {
    var r = $('modal-root');
    if (r.firstChild) { r.innerHTML = ''; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  };

  /* ---------- navigation ---------- */

  var SCREENS = ['today', 'scan', 'signal', 'lab', 'journal', 'settings'];

  UI.setScreen = function (name) {
    SCREENS.forEach(function (s) {
      var el = $('screen-' + s);
      if (el) el.hidden = (s !== name);
    });
    ['today', 'scan', 'lab', 'journal', 'settings'].forEach(function (s) {
      var t = $('tab-' + s);
      if (!t) return;
      var active = (s === name);
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $('main').focus();
    window.scrollTo(0, 0);
  };

  /* ---------- status strip ---------- */

  UI.renderStatus = function (st) {
    $('chip-session').textContent = 'Session ' + (st.session ? U.SESSION_LABEL[st.session] : '--');
    var rg = $('chip-regime');
    rg.textContent = 'Regime ' + (st.regime || '--');
    rg.className = 'chip ' + (st.regime === 'NEWS_RISK' || st.regime === 'HIGH_VOLATILITY' || st.regime === 'LOW_LIQUIDITY' ? 'chip-warn' : 'chip-ok');

    var fr = $('chip-fresh');
    if (!st.lastUpdate) { fr.textContent = 'Data never fetched'; fr.className = 'chip chip-muted'; }
    else {
      fr.textContent = 'Data ' + U.fmtAgo(st.lastUpdate, Date.now());
      fr.className = 'chip ' + (st.stale ? 'chip-bad' : 'chip-ok');
    }

    var slot = $('banner-slot');
    slot.innerHTML = '';
    (st.banners || []).forEach(function (b) {
      var d = document.createElement('div');
      d.className = 'banner' + (b.severity === 'bad' ? ' bad' : '');
      d.setAttribute('role', b.severity === 'bad' ? 'alert' : 'status');
      d.innerHTML = '<strong>' + e(b.title) + '</strong><span>' + e(b.text) + '</span>';
      slot.appendChild(d);
    });
  };

  /* ---------- shared fragments ---------- */

  function decisionBlock(sig) {
    var word = sig.decision === 'NO_TRADE' ? 'NO TRADE' : sig.decision;
    var meta = [];
    meta.push(U.TF_LABEL[sig.entryTf] + ' entry timing');
    if (sig.setup) meta.push(sig.setup.label);
    if (sig.expiresAt) meta.push('expires ' + U.fmtIn(sig.expiresAt, Date.now()));
    return '<div class="decision decision-' + e(sig.decision) + '">' +
      '<div class="eyebrow">' + e(sig.symbol) + '</div>' +
      '<p class="decision-word">' + e(word) + '</p>' +
      '<div class="decision-meta">' + e(meta.join(' · ')) + '</div>' +
      '</div>';
  }

  function ladder(sig) {
    var byId = {};
    (sig.gates || []).forEach(function (g) { byId[g.id] = g; });
    var dead = false;
    var items = E.GATES.map(function (def) {
      var g = byId[def.id];
      var status = g ? g.status : (dead ? 'SKIPPED' : 'SKIPPED');
      if (g && g.status === 'FAIL') dead = true;
      else if (!g) dead = true;
      var detail = g ? g.detail : 'Not evaluated — the pipeline stopped earlier.';
      return '<li class="gate-' + e(status) + (dead ? ' is-dead' : '') + '">' +
        '<div class="gate-num">' + e(def.n) + '</div>' +
        '<div><div class="gate-label">' + e(def.label) +
        '<span class="gate-status">' + e(status) + '</span></div>' +
        '<div class="gate-detail">' + e(detail) + '</div></div></li>';
    });
    return '<ul class="ladder">' + items.join('') + '</ul>';
  }

  function scoreBlock(sig) {
    if (!sig.score) return '';
    var rows = E.SCORE_GROUPS.map(function (g) {
      var v = sig.score.groups[g.id] || 0;
      var note = sig.score.notes[g.id] || '';
      return '<div class="bar-row">' +
        '<div class="bar-head"><span>' + e(g.label) + '</span><span class="num">' + e(U.round(v, 1)) + ' / ' + g.max + '</span></div>' +
        '<div class="bar"><div class="bar-fill" style="width:' + Math.round((v / g.max) * 100) + '%"></div></div>' +
        '<div class="bar-note">' + e(note) + '</div></div>';
    }).join('');
    return '<div class="card"><div class="card-head"><h3 class="card-title">Setup score</h3>' +
      '<span class="eyebrow">evidence, not accuracy</span></div>' +
      '<div class="score-total"><span class="num">' + e(sig.score.total) + '</span><span class="den">/ 100</span></div>' +
      rows +
      '<p class="note">Setup score measures how much independent evidence lines up right now. It is not a probability and it is not a win rate. Correlated indicators are combined inside a capped group so four agreeing oscillators cannot inflate it.</p>' +
      '</div>';
  }

  function sampleWarn(text, have, need) {
    var pctv = need ? Math.min(100, Math.round((have / need) * 100)) : 0;
    return '<div class="insufficient">' + e(text) +
      '<div class="sample-bar"><div style="width:' + pctv + '%"></div></div></div>';
  }

  function confidenceBlock(sig) {
    var c = sig.confidence;
    var head = '<div class="card"><div class="card-head"><h3 class="card-title">Model confidence</h3><span class="eyebrow">calibrated</span></div>';
    if (!c || !c.available) {
      return head + sampleWarn(
        (c && c.reason) ? c.reason : 'Not enough resolved signals to calibrate confidence yet.',
        (c && (c.n || c.totalN)) || 0, c && c.status === 'THIN_BAND' ? 15 : 40) +
        '<p class="note">Until then EdgePilot shows nothing here. A number produced from the setup score alone would just be the score wearing a percentage sign.</p></div>';
    }
    return head +
      '<div class="score-total"><span class="num">' + e(U.pct(c.value)) + '</span><span class="den">calibrated win rate</span></div>' +
      '<table class="levels"><tbody>' +
      '<tr><th>Score band</th><td>' + e(c.lo + ' – ' + c.hi) + '</td></tr>' +
      '<tr><th>Resolved signals in band</th><td>' + e(c.n) + '</td></tr>' +
      '<tr><th>Raw band win rate</th><td>' + e(U.pct(c.raw)) + '</td></tr>' +
      (c.band ? '<tr><th>90% interval</th><td>' + e(U.pct(c.band.lo) + ' – ' + U.pct(c.band.hi)) + '</td></tr>' : '') +
      '<tr><th>Expectancy in band</th><td>' + e(U.round(c.expectancyR, 2)) + 'R</td></tr>' +
      '</tbody></table><p class="note">' + e(c.note) + '</p></div>';
  }

  function historyBlock(sig) {
    var h = sig.history;
    var head = '<div class="card"><div class="card-head"><h3 class="card-title">Historical win rate</h3><span class="eyebrow">resolved signals only</span></div>';
    if (!h || !h.available) {
      return head + sampleWarn(
        'Only ' + ((h && h.n) || 0) + ' of the ' + ((h && h.needed) || S.MIN_SAMPLE) +
        ' resolved signals needed for ' + ((h && h.label) || 'this context') + '.',
        (h && h.n) || 0, (h && h.needed) || S.MIN_SAMPLE) +
        '<p class="note">A win rate from a handful of trades is noise. EdgePilot withholds the number rather than showing a flattering one.</p></div>';
    }
    function mini(p, label) {
      if (!p || !p.n) return '<div class="stat"><div class="stat-k">' + e(label) + '</div><div class="stat-v">--</div><div class="stat-sub">no sample</div></div>';
      return '<div class="stat"><div class="stat-k">' + e(label) + '</div><div class="stat-v">' + e(U.pct(p.winRate)) +
        '</div><div class="stat-sub">n=' + e(p.n) + ' · ' + e(U.round(p.expectancyR, 2)) + 'R</div></div>';
    }
    return head +
      '<div class="score-total"><span class="num">' + e(U.pct(h.winRate)) + '</span><span class="den">n = ' + e(h.n) + '</span></div>' +
      '<p class="note">Scope: ' + e(h.label) + '. 90% interval ' +
      e(h.band ? U.pct(h.band.lo) + ' – ' + U.pct(h.band.hi) : 'n/a') +
      '. Exact pair/timeframe/regime/session sample so far: ' + e(h.exactN) + '.</p>' +
      '<div class="stat-grid" style="margin-top:12px">' + mini(h.last30, 'Recent 30') + mini(h.last50, 'Recent 50') + '</div>' +
      '</div>';
  }

  function levelsBlock(sig) {
    if (!sig.levels) return '';
    var lv = sig.levels, sym = sig.symbol;
    var dirClass = sig.direction === 'BUY' ? 'val-buy' : 'val-sell';
    return '<div class="card"><div class="card-head"><h3 class="card-title">Levels and size</h3>' +
      '<span class="eyebrow">' + e(sig.direction || '--') + '</span></div>' +
      '<table class="levels"><tbody>' +
      '<tr><th>Entry zone</th><td class="' + dirClass + '">' + e(U.price(lv.entryLow, sym) + ' – ' + U.price(lv.entryHigh, sym)) + '</td></tr>' +
      '<tr><th>Reference fill</th><td>' + e(U.price(lv.entryRef, sym)) + '</td></tr>' +
      '<tr><th>Stop-loss</th><td>' + e(U.price(lv.sl, sym)) + '</td></tr>' +
      '<tr><th>Target 1</th><td>' + e(U.price(lv.tp1, sym)) + '</td></tr>' +
      '<tr><th>Target 2</th><td>' + e(U.price(lv.tp2, sym)) + '</td></tr>' +
      '<tr><th>Net R:R to target 1</th><td>' + e(U.round(lv.netRR1, 2)) + ' : 1</td></tr>' +
      '<tr><th>Net R:R to target 2</th><td>' + e(U.round(lv.netRR2, 2)) + ' : 1</td></tr>' +
      '<tr><th>Stop distance</th><td>' + e(U.round(lv.stopAtr, 2)) + '× ATR</td></tr>' +
      '<tr><th>Estimated size</th><td>' + e(lv.size.lots != null ? lv.size.lots + ' lots' : '--') + '</td></tr>' +
      '<tr><th>Risk per trade</th><td>' + e(U.money(lv.size.riskAmount)) + '</td></tr>' +
      '<tr><th>Costs assumed</th><td>' + e('sp ' + U.price(lv.costs.spread, sym) + ' · sl ' + U.price(lv.costs.slippage, sym) + ' · ' + U.money(lv.costs.commissionPerLot) + '/lot') + '</td></tr>' +
      '</tbody></table>' +
      '<p class="note">' + e(lv.size.note) + ' The entry is quoted as a zone because filling at one exact print is not something you control.</p>' +
      '</div>';
  }

  function contextBlock(sig) {
    var rows = [];
    if (sig.bias) {
      rows.push(['Daily bias', sig.bias.d1.dir + ' (' + sig.bias.d1.structure + ')']);
      rows.push(['4-hour bias', sig.bias.h4.dir + ' (' + sig.bias.h4.structure + ')']);
    }
    if (sig.regime) {
      rows.push(['Regime', sig.regime.display]);
      rows.push(['H4 ADX', U.round(sig.regime.adx, 1)]);
      rows.push(['ATR percentile', sig.regime.atrPercentile != null ? Math.round(sig.regime.atrPercentile * 100) + '%' : 'unknown']);
    }
    if (U.isNum(sig.atr)) rows.push([U.TF_LABEL[sig.entryTf] + ' ATR(14)', U.price(sig.atr, sig.symbol)]);
    rows.push(['Session', U.SESSION_LABEL[sig.session]]);
    if (sig.news) {
      rows.push(['News status', sig.news.status + (sig.news.minutesToNext != null ? ' (' + sig.news.minutesToNext + ' min)' : '')]);
      if (sig.news.events && sig.news.events.length) {
        rows.push(['Next high impact', sig.news.events[0].currency + ' ' + sig.news.events[0].title]);
      }
    }
    if (sig.entryConfirm && sig.entryConfirm.rangePos != null) {
      rows.push(['Range position', Math.round(sig.entryConfirm.rangePos * 100) + '%']);
    }
    return '<div class="card"><div class="card-head"><h3 class="card-title">Market context</h3>' +
      '<span class="eyebrow">D1 · H4 · ' + e(U.TF_LABEL[sig.entryTf]) + '</span></div>' +
      '<table class="levels"><tbody>' +
      rows.map(function (r) { return '<tr><th>' + e(r[0]) + '</th><td>' + e(r[1]) + '</td></tr>'; }).join('') +
      '</tbody></table>' +
      (sig.regime && sig.regime.detail ? '<p class="note">' + e(sig.regime.detail) + '</p>' : '') +
      '</div>';
  }

  function reasonsBlock(sig) {
    var r = sig.reasons || {};
    var out = '<div class="card"><div class="card-head"><h3 class="card-title">Why this passed or failed</h3></div>';
    if (r.fail && r.fail.length) out += '<ul class="reasons fail">' + r.fail.map(function (x) { return '<li>' + e(x) + '</li>'; }).join('') + '</ul>';
    if (r.warn && r.warn.length) out += '<ul class="reasons warn">' + r.warn.map(function (x) { return '<li>' + e(x) + '</li>'; }).join('') + '</ul>';
    if (r.pass && r.pass.length) out += '<ul class="reasons pass">' + r.pass.map(function (x) { return '<li>' + e(x) + '</li>'; }).join('') + '</ul>';
    if (sig.rejectedSetups && sig.rejectedSetups.length) {
      out += '<p class="note">Also considered and rejected: ' +
        e(sig.rejectedSetups.map(function (x) { return x.label + ' (' + x.stage.toLowerCase() + ')'; }).join(', ')) + '.</p>';
    }
    return out + '</div>';
  }

  function voteBlock(sig) {
    if (!sig.vote || !sig.vote.table || !sig.vote.table.length) return '';
    var rows = sig.vote.table.map(function (r) {
      return '<tr><td class="name">' + e(r.label) + '</td><td>' + e(r.n) + '</td><td>' +
        e(r.n >= S.MIN_WEIGHT_SAMPLE ? U.round(r.expectancyR, 2) + 'R' : '--') + '</td><td>' +
        e(r.noTradeWeight ? 'NO TRADE' : U.round(r.forWeight, 2)) + '</td></tr>';
    }).join('');
    return '<div class="card"><div class="card-head"><h3 class="card-title">Strategy vote</h3>' +
      '<span class="eyebrow">' + e(sig.vote.weighted ? 'weighted' : 'unweighted') + '</span></div>' +
      '<table class="vote-table"><thead><tr><th>Strategy</th><th>n</th><th>Exp.</th><th>Weight</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<p class="note">' + e(sig.vote.detail) + '</p></div>';
  }

  /* ---------- signal detail ---------- */

  UI.renderSignal = function (sig, opts) {
    opts = opts || {};
    var html = decisionBlock(sig);

    if (sig.dataQuality && sig.dataQuality.status !== 'OK') {
      html += '<div class="banner' + (sig.dataQuality.status === 'FAIL' ? ' bad' : '') + '" role="alert">' +
        '<strong>' + e(sig.dataQuality.status === 'FAIL' ? 'Data rejected.' : 'Data degraded.') + '</strong>' +
        '<span>' + e(sig.dataQuality.issues.map(function (x) { return x.text; }).join(' ')) + '</span></div>';
    }

    html += '<div class="card"><div class="card-head"><h3 class="card-title">Pipeline</h3>' +
      '<span class="eyebrow">six gates</span></div>' + ladder(sig) + '</div>';

    if (sig.setup) {
      html += '<div class="card"><div class="card-head"><h3 class="card-title">' + e(sig.setup.label) + '</h3></div>' +
        '<p class="note" style="color:var(--text-dim);font-size:13.5px">' + e(sig.setup.notes) + '</p>' +
        (sig.entryConfirm ? '<ul class="reasons pass">' + sig.entryConfirm.notes.map(function (x) { return '<li>' + e(x) + '</li>'; }).join('') + '</ul>' : '') +
        '</div>';
    }

    html += levelsBlock(sig);
    html += contextBlock(sig);
    html += scoreBlock(sig);
    html += historyBlock(sig);
    html += confidenceBlock(sig);
    html += voteBlock(sig);
    html += reasonsBlock(sig);

    html += '<div class="card" id="ai-card"><div class="card-head"><h3 class="card-title">Explanation</h3>' +
      '<span class="eyebrow">optional</span></div><div id="ai-slot"></div></div>';

    html += '<div class="card"><button class="btn btn-secondary btn-block" type="button" id="btn-log-trade">Log this to the journal</button></div>';

    html += '<p class="legal">This is educational analysis, not financial advice. EdgePilot does not guarantee accuracy and cannot predict what price will do next.</p>';

    $('signal-body').innerHTML = html;
    UI.setScreen('signal');

    var logBtn = $('btn-log-trade');
    if (logBtn && opts.onLog) logBtn.addEventListener('click', function () { opts.onLog(sig); });

    var slot = $('ai-slot');
    if (!opts.aiEnabled) {
      slot.innerHTML = '<p class="note">AI explanations are switched off. Turn them on in Settings if you want a plain-language readout of the numbers above.</p>';
    } else {
      var b = document.createElement('button');
      b.className = 'btn btn-ghost btn-block';
      b.type = 'button';
      b.textContent = 'Explain this decision';
      b.addEventListener('click', function () { opts.onExplain && opts.onExplain(sig, slot, b); });
      slot.appendChild(b);
    }
  };

  UI.renderAiText = function (slot, res) {
    var paras = U.aiToParagraphs(res.text);
    slot.innerHTML = '<div class="ai-block">' +
      paras.map(function (p) { return '<p>' + p + '</p>'; }).join('') +
      '<p class="ai-disclaimer">' + e(res.disclaimer || 'This is educational analysis, not financial advice.') +
      (res.model ? ' Model: ' + e(res.model) + '.' : '') + '</p></div>';
  };

  /* ---------- today ---------- */

  UI.renderToday = function (state, handlers) {
    var body = $('today-body');
    var rs = state.riskState;
    var strip = $('today-risk');
    if (rs) {
      strip.hidden = false;
      strip.innerHTML =
        '<span>Today <b>' + e(U.round(rs.todayR, 2)) + 'R</b></span>' +
        '<span>Losing streak <b>' + e(rs.consecutiveLosses) + '</b></span>' +
        '<span>Daily limit <b>' + e(rs.dailyLossHit ? 'REACHED' : 'ok') + '</b></span>' +
        (rs.cooldownUntil > Date.now() ? '<span>Cooldown until <b>' + e(U.fmtTime(rs.cooldownUntil)) + '</b></span>' : '');
    } else strip.hidden = true;

    var direct = state.settings.dataMode === 'direct';
    var configured = direct ? !!state.settings.twelvedataKey : !!state.settings.backendUrl;
    if (!configured) {
      body.innerHTML = '<div class="empty"><div class="empty-head">NO DATA SOURCE</div>' +
        '<p>' + (direct
          ? 'Direct mode is selected but no TwelveData key is set. Add one in Settings.'
          : 'EdgePilot needs a backend before it can read a single candle. Deploy the worker, then add its address in Settings.') +
        '</p></div>';
      var b0 = document.createElement('button');
      b0.className = 'btn btn-primary'; b0.type = 'button'; b0.textContent = 'Open settings';
      b0.addEventListener('click', function () { UI.setScreen('settings'); });
      body.querySelector('.empty').appendChild(b0);
      $('today-sub').textContent = 'Nothing has been fetched yet.';
      return;
    }

    if (!state.results || !state.results.length) {
      body.innerHTML = '<div class="empty"><div class="empty-head">NOTHING SCANNED YET</div>' +
        '<p>Run a scan to see the current regime and whether any instrument clears all six gates.</p></div>';
      var b1 = document.createElement('button');
      b1.className = 'btn btn-primary'; b1.type = 'button'; b1.textContent = 'Analyze now';
      b1.addEventListener('click', function () { handlers.onScan(); });
      body.querySelector('.empty').appendChild(b1);
      return;
    }

    var tradeable = state.results.filter(function (r) { return r.decision === 'BUY' || r.decision === 'SELL'; })
      .sort(function (a, b) { return (b.score ? b.score.total : 0) - (a.score ? a.score.total : 0); });
    var waiting = state.results.filter(function (r) { return r.decision === 'WAIT'; })
      .sort(function (a, b) { return (b.score ? b.score.total : 0) - (a.score ? a.score.total : 0); });

    $('today-sub').textContent = state.results.length + ' instruments checked at ' + U.fmtTime(state.lastUpdate) + '.';

    var html = '';
    if (!tradeable.length) {
      html += '<div class="empty"><div class="empty-head">NO QUALITY SETUP RIGHT NOW</div>' +
        '<p>Nothing cleared all six gates on this pass. Waiting is the position. ' +
        (waiting.length ? 'There ' + (waiting.length === 1 ? 'is 1 setup' : 'are ' + waiting.length + ' setups') + ' worth watching below.' : '') +
        '</p></div>';
    } else {
      html += '<div class="eyebrow" style="margin:4px 0 8px">Cleared every gate</div>';
      html += tradeable.map(rowFor).join('');
    }

    if (waiting.length) {
      html += '<div class="eyebrow" style="margin:18px 0 8px">Watching, below your score threshold</div>';
      html += waiting.map(rowFor).join('');
    }

    var blocked = state.results.filter(function (r) { return r.decision === 'NO_TRADE'; });
    if (blocked.length) {
      html += '<div class="eyebrow" style="margin:18px 0 8px">Filtered out (' + blocked.length + ')</div>';
      html += blocked.map(rowFor).join('');
    }

    body.innerHTML = html;
    wireRows(body, state, handlers);
  };

  function rowFor(sig) {
    var tag = sig.decision;
    var sub;
    if (sig.decision === 'BUY' || sig.decision === 'SELL') {
      sub = 'Score ' + (sig.score ? sig.score.total : '--') + ' · net R:R ' + U.round(sig.levels.netRR1, 2) + ' · ' + sig.setup.label;
    } else if (sig.decision === 'WAIT') {
      sub = 'Score ' + (sig.score ? sig.score.total : '--') + ' · ' + (sig.reasons.warn[0] || 'below threshold');
    } else {
      sub = 'Stopped at gate ' + (sig.failedAt || '--') + ' · ' + (sig.reasons.fail[0] || 'no qualifying setup');
    }
    return '<button class="row-btn" type="button" data-sig="' + e(sig.id) + '">' +
      '<div class="row-top"><span class="row-sym">' + e(sig.symbol) + '</span>' +
      '<span class="row-tag tag-' + e(tag) + '">' + e(tag === 'NO_TRADE' ? 'NO TRADE' : tag) + '</span></div>' +
      '<div class="row-sub">' + e(sub) + '</div></button>';
  }
  UI.rowFor = rowFor;

  function wireRows(container, state, handlers) {
    Array.prototype.forEach.call(container.querySelectorAll('[data-sig]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-sig');
        var sig = (state.results || []).filter(function (r) { return r.id === id; })[0];
        if (sig) handlers.onOpen(sig);
      });
    });
  }
  UI.wireRows = wireRows;

  /* ---------- scanner ---------- */

  UI.renderScan = function (state, handlers) {
    var body = $('scan-body');
    if (!state.results || !state.results.length) {
      body.innerHTML = '<div class="empty"><div class="empty-head">NOT SCANNED</div>' +
        '<p>Each instrument is pushed through the same six gates. The scanner reports where each one stopped.</p></div>';
      return;
    }
    var order = { BUY: 0, SELL: 0, WAIT: 1, NO_TRADE: 2 };
    var list = state.results.slice().sort(function (a, b) {
      var d = order[a.decision] - order[b.decision];
      if (d) return d;
      return (b.score ? b.score.total : 0) - (a.score ? a.score.total : 0);
    });
    body.innerHTML = list.map(rowFor).join('');
    wireRows(body, state, handlers);
  };

  /* ---------- performance lab ---------- */

  function statCell(k, v, sub) {
    return '<div class="stat"><div class="stat-k">' + e(k) + '</div><div class="stat-v">' + e(v) +
      '</div>' + (sub ? '<div class="stat-sub">' + e(sub) + '</div>' : '') + '</div>';
  }

  function perfGrid(p) {
    return '<div class="stat-grid">' +
      statCell('Resolved', p.n, p.wins + 'W / ' + p.losses + 'L') +
      statCell('Win rate', p.winRate == null ? '--' : U.pct(p.winRate), p.band ? U.pct(p.band.lo, 0) + '–' + U.pct(p.band.hi, 0) + ' @90%' : '') +
      statCell('Expectancy', p.expectancyR == null ? '--' : p.expectancyR + 'R', 'per signal') +
      statCell('Profit factor', p.profitFactor == null ? '--' : (p.profitFactor === Infinity ? '∞' : p.profitFactor), '') +
      statCell('Avg win', p.avgWinR == null ? '--' : p.avgWinR + 'R', '') +
      statCell('Avg loss', p.avgLossR == null ? '--' : '-' + p.avgLossR + 'R', '') +
      statCell('Max drawdown', p.maxDrawdownR == null ? '--' : p.maxDrawdownR + 'R', 'peak to trough') +
      statCell('Worst streak', p.maxLosingStreak, 'consecutive losses') +
      '</div>';
  }
  UI.perfGrid = perfGrid;

  function equitySvg(equity) {
    if (!equity || equity.length < 2) return '';
    var w = 320, h = 64, min = Math.min.apply(null, equity.concat([0])), max = Math.max.apply(null, equity.concat([0]));
    var span = (max - min) || 1;
    var pts = equity.map(function (v, i) {
      return (i / (equity.length - 1) * w).toFixed(1) + ',' + (h - (v - min) / span * h).toFixed(1);
    }).join(' ');
    var zeroY = (h - (0 - min) / span * h).toFixed(1);
    return '<svg class="equity" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" role="img" aria-label="Cumulative R equity curve">' +
      '<line x1="0" y1="' + zeroY + '" x2="' + w + '" y2="' + zeroY + '" stroke="#2a3a50" stroke-width="1"/>' +
      '<polyline points="' + pts + '" fill="none" stroke="#6d93c6" stroke-width="1.5"/></svg>';
  }

  UI.renderLabLive = function (resolved) {
    var el = $('lab-live');
    var p = S.performance(resolved);
    if (!p.n) {
      el.innerHTML = '<div class="empty"><div class="empty-head">NO RESOLVED SIGNALS YET</div>' +
        '<p>This page fills in as signals this app generated reach a target, a stop, or a timeout. It stays empty until then rather than showing placeholder numbers.</p></div>';
      return;
    }
    var html = perfGrid(p) + equitySvg(p.equity);
    html += '<div class="card" style="margin-top:12px"><div class="card-head"><h3 class="card-title">Recent form</h3></div>' +
      '<div class="stat-grid">' +
      statCell('Last 30', S.recent(resolved, 30).winRate == null ? '--' : U.pct(S.recent(resolved, 30).winRate), 'n=' + S.recent(resolved, 30).n) +
      statCell('Last 50', S.recent(resolved, 50).winRate == null ? '--' : U.pct(S.recent(resolved, 50).winRate), 'n=' + S.recent(resolved, 50).n) +
      '</div></div>';

    [['symbol', 'By instrument'], ['entryTf', 'By timeframe'], ['regime', 'By regime'], ['session', 'By session']].forEach(function (g) {
      var rows = S.groupBy(resolved, g[0]);
      if (!rows.length) return;
      html += '<div class="card"><div class="card-head"><h3 class="card-title">' + e(g[1]) + '</h3></div>' +
        '<table class="vote-table"><thead><tr><th>' + e(g[1].replace('By ', '')) + '</th><th>n</th><th>Win</th><th>Exp.</th></tr></thead><tbody>' +
        rows.map(function (r) {
          return '<tr><td class="name">' + e(r.key) + '</td><td>' + e(r.n) + '</td><td>' +
            e(r.n >= 10 ? U.pct(r.winRate) : '--') + '</td><td>' + e(r.n >= 10 ? r.expectancyR + 'R' : '--') + '</td></tr>';
        }).join('') + '</tbody></table>' +
        '<p class="note">Cells stay blank below 10 resolved signals.</p></div>';
    });

    el.innerHTML = html;
  };

  UI.renderCalibration = function (resolved) {
    var el = $('lab-cal');
    var cal = S.calibrate(resolved);
    var html = '<div class="card"><div class="card-head"><h3 class="card-title">Score to outcome</h3>' +
      '<span class="eyebrow">' + e(cal.status) + '</span></div>';
    if (cal.status === 'UNCALIBRATED') {
      html += sampleWarn('Calibration needs at least 40 resolved signals. Currently ' + cal.totalN + '.', cal.totalN, 40);
      html += '<p class="note">Until the model is calibrated, EdgePilot shows the setup score and refuses to convert it into a probability.</p>';
    } else {
      html += '<table class="vote-table"><thead><tr><th>Band</th><th>n</th><th>Raw</th><th>Calibrated</th></tr></thead><tbody>' +
        cal.bands.map(function (b) {
          return '<tr><td class="name">' + e(b.lo + '–' + b.hi) + '</td><td>' + e(b.n) + '</td><td>' +
            e(b.n >= 15 ? U.pct(b.rawWinRate) : '--') + '</td><td>' +
            e(b.n >= 15 ? U.pct(b.shrunkWinRate) : '--') + '</td></tr>';
        }).join('') + '</tbody></table>' +
        '<p class="note">Calibrated values are shrunk toward the overall base rate of ' + e(U.pct(cal.globalWinRate)) +
        ' so a thin band cannot produce an extreme number. If a higher band does not out-perform a lower one, the score is not yet doing its job.</p>';
    }
    el.innerHTML = html + '</div>';
  };

  UI.renderBacktest = function (res) {
    var el = $('bt-body');
    if (!res) { el.innerHTML = ''; return; }
    if (!res.ok) { el.innerHTML = '<div class="banner bad" role="alert"><strong>Cannot run.</strong><span>' + e(res.error) + '</span></div>'; return; }
    if (!res.settled) { el.innerHTML = '<div class="empty"><div class="empty-head">NO RESOLVED SIGNALS</div><p>' + e(res.note) + '</p></div>'; return; }

    var html = '<div class="card"><div class="card-head"><h3 class="card-title">Out of sample</h3>' +
      '<span class="eyebrow">validation folds only</span></div>' + perfGrid(res.outOfSample) +
      '<p class="note">These signals were produced with parameters chosen on earlier data and never seen by the optimiser.</p></div>';

    html += '<div class="card"><div class="card-head"><h3 class="card-title">In sample</h3>' +
      '<span class="eyebrow">optimisation folds</span></div>' + perfGrid(res.inSample) +
      '<p class="note">Shown only so you can measure the gap. If in-sample is far better than out-of-sample, the parameters are fitted to noise.</p></div>';

    html += '<div class="card"><div class="card-head"><h3 class="card-title">Folds</h3></div>' +
      '<table class="vote-table"><thead><tr><th>Fold</th><th>Params</th><th>IS exp.</th><th>OOS exp.</th></tr></thead><tbody>' +
      res.folds.map(function (f) {
        if (f.skipped) return '<tr><td class="name">' + e(f.fold) + '</td><td colspan="3">' + e(f.reason) + '</td></tr>';
        return '<tr><td class="name">' + e(f.fold) + '</td><td>' + e('s' + f.chosen.minScore + ' r' + f.chosen.minRR) + '</td><td>' +
          e(f.inSample.expectancyR + 'R (' + f.inSample.n + ')') + '</td><td>' +
          e((f.outOfSample.n ? f.outOfSample.expectancyR + 'R' : '--') + ' (' + f.outOfSample.n + ')') + '</td></tr>';
      }).join('') + '</tbody></table></div>';

    html += '<div class="card"><div class="card-head"><h3 class="card-title">What this run does not tell you</h3></div>' +
      '<ul class="reasons warn">' + res.caveats.map(function (c) { return '<li>' + e(c) + '</li>'; }).join('') + '</ul></div>';

    html += '<p class="note">' + e(res.symbol + ' · ' + U.TF_LABEL[res.entryTf] + ' · ' + res.candlesUsed + ' candles · ' +
      U.fmtTime(res.from) + ' to ' + U.fmtTime(res.to) + ' · ' + res.settled + ' resolved signals') + '</p>';

    el.innerHTML = html;
  };

  /* ---------- journal ---------- */

  UI.renderJournal = function (signals, journal, handlers) {
    var body = $('journal-body');
    var list = (signals || []).slice().sort(function (a, b) { return b.createdAt - a.createdAt; })
      .filter(function (s) { return s.status === 'PENDING' || s.outcome; });
    if (!list.length) {
      body.innerHTML = '<div class="empty"><div class="empty-head">JOURNAL EMPTY</div>' +
        '<p>Signals appear here once the engine produces a BUY or SELL. Check open signals to walk them forward against real candles.</p></div>';
      return;
    }
    var notesBySig = {};
    (journal || []).forEach(function (j) { if (j.signalId) (notesBySig[j.signalId] = notesBySig[j.signalId] || []).push(j); });

    body.innerHTML = list.map(function (s) {
      var outcome = s.outcome || 'OPEN';
      var r = U.isNum(s.rMultiple) ? (s.rMultiple > 0 ? '+' : '') + s.rMultiple + 'R' : '';
      var notes = (notesBySig[s.id] || []).length;
      return '<button class="row-btn" type="button" data-jr="' + e(s.id) + '">' +
        '<div class="row-top"><span class="row-sym">' + e(s.symbol + ' ' + (s.direction || '')) + '</span>' +
        '<span class="row-tag tag-' + e(U.isNum(s.rMultiple) ? (s.rMultiple > 0 ? 'BUY' : 'SELL') : 'WAIT') + '">' +
        e(outcome + (r ? ' ' + r : '')) + '</span></div>' +
        '<div class="row-sub">' + e(U.fmtTime(s.createdAt) + ' · score ' + (s.score ? s.score.total : '--') +
          ' · ' + (s.setup ? s.setup.label : '--') + (notes ? ' · ' + notes + ' note' + (notes > 1 ? 's' : '') : '')) + '</div></button>';
    }).join('');

    Array.prototype.forEach.call(body.querySelectorAll('[data-jr]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-jr');
        var s = list.filter(function (x) { return x.id === id; })[0];
        if (s) handlers.onOpen(s, notesBySig[id] || []);
      });
    });
  };

})(typeof self !== 'undefined' ? self : this);
