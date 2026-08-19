/**
 * EdgePilot backend - Cloudflare Worker.
 *
 * This is the only place a provider credential exists. The PWA never receives
 * one, never stores one, and cannot leak one through a backup file.
 *
 * Required secrets (wrangler secret put NAME):
 *   TWELVEDATA_KEY   market data
 * Optional secrets:
 *   GEMINI_KEY       enables /ai/explain
 *   ACCESS_TOKEN     if set, callers must send ?t=<token>
 * Required vars (wrangler.toml [vars]):
 *   ALLOWED_ORIGIN   e.g. "https://yourname.github.io"
 * Optional vars:
 *   NEWS_FEED_URL    JSON economic calendar; without it /calendar reports
 *                    "unavailable", which the app treats as unverified risk
 *                    rather than as "no news".
 */

const TF_MAP = { '15min': '15min', '1h': '1h', '4h': '4h', '1day': '1day' };
const TF_MS = { '15min': 9e5, '1h': 36e5, '4h': 144e5, '1day': 864e5 };
const SYMBOLS = new Set(['XAU/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'USD/CAD', 'BTC/USD']);

const AI_SYSTEM = [
  'You explain a trading setup that has ALREADY been computed by a deterministic engine.',
  'Absolute rules:',
  '1. Use only the numbers in the supplied fact sheet. Never state a price, indicator value, news event, win rate, sample size or statistic that is not in it.',
  '2. If a field says data is unavailable or the sample is insufficient, say exactly that. Never estimate a replacement.',
  '3. Never change, widen, tighten or second-guess the entry, stop or targets. Never tell the reader to override a filter.',
  '4. You may conclude that no trade is warranted. That is a valid and useful answer.',
  '5. Use cautious language. Write "conditions currently support" or "the filters that passed were", never "this trade will win" or "this is a high probability trade".',
  '6. No guarantees, no profit claims, no urgency, no emoji.',
  '7. Four short paragraphs maximum, plain prose, no markdown headings or bullet characters.',
  '8. End with exactly: This is educational analysis, not financial advice.'
].join('\n');

function cors(env, extra = {}) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
    ...extra
  };
}

function json(env, obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(env, extra) }
  });
}

function authOk(env, url) {
  if (!env.ACCESS_TOKEN) return true;
  return url.searchParams.get('t') === env.ACCESS_TOKEN;
}

/* ---------- market data ---------- */

async function fetchOhlc(env, symbol, interval, outputsize) {
  const key = env.TWELVEDATA_KEY;
  if (!key) throw new Error('Market data provider is not configured on the backend.');
  const u = new URL('https://api.twelvedata.com/time_series');
  u.searchParams.set('symbol', symbol);
  u.searchParams.set('interval', TF_MAP[interval]);
  u.searchParams.set('outputsize', String(outputsize));
  u.searchParams.set('timezone', 'UTC');
  u.searchParams.set('order', 'ASC');
  u.searchParams.set('apikey', key);

  const r = await fetch(u.toString(), { cf: { cacheTtl: 30 } });
  const d = await r.json();
  if (d.status === 'error' || !Array.isArray(d.values)) {
    throw new Error(String(d.message || 'Provider returned no series').slice(0, 200));
  }
  const nowMs = Date.now();
  const tfMs = TF_MS[interval];
  const candles = [];
  for (const v of d.values) {
    const t = Date.parse(v.datetime.replace(' ', 'T') + 'Z');
    if (!isFinite(t)) continue;
    if (t + tfMs > nowMs) continue; // never hand back a forming candle
    const o = +v.open, h = +v.high, l = +v.low, c = +v.close;
    if (![o, h, l, c].every(Number.isFinite)) continue;
    candles.push({ t, o, h, l, c, v: v.volume != null ? +v.volume : null });
  }
  candles.sort((a, b) => a.t - b.t);
  return candles;
}

/* ---------- calendar ---------- */

async function fetchCalendar(env) {
  if (!env.NEWS_FEED_URL) {
    return { available: false, reason: 'No economic calendar feed is configured on the backend. News risk is unverified.' };
  }
  const r = await fetch(env.NEWS_FEED_URL, { cf: { cacheTtl: 900 } });
  if (!r.ok) return { available: false, reason: 'Calendar feed returned HTTP ' + r.status + '.' };
  let raw;
  try { raw = await r.json(); } catch { return { available: false, reason: 'Calendar feed did not return JSON.' }; }

  const arr = Array.isArray(raw) ? raw : (Array.isArray(raw.events) ? raw.events : null);
  if (!arr) return { available: false, reason: 'Calendar feed shape not recognised.' };

  const events = [];
  for (const e of arr) {
    const t = Date.parse(e.date || e.time || e.datetime || '');
    if (!isFinite(t)) continue;
    const impact = String(e.impact || e.importance || '').toUpperCase();
    if (!impact.includes('HIGH')) continue;
    events.push({
      time: t,
      currency: String(e.country || e.currency || '').toUpperCase().slice(0, 8),
      title: String(e.title || e.event || '').slice(0, 140),
      impact: 'HIGH'
    });
  }
  return { available: true, source: 'backend calendar feed', events };
}

/* ---------- ai ---------- */

async function explain(env, facts) {
  if (!env.GEMINI_KEY) throw new Error('AI is not configured on this backend.');
  const body = {
    systemInstruction: { parts: [{ text: AI_SYSTEM }] },
    contents: [{
      role: 'user',
      parts: [{ text: 'Fact sheet (the only information you may use):\n\n' + JSON.stringify(facts, null, 2) }]
    }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 700 }
  };
  const r = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + env.GEMINI_KEY,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  const d = await r.json();
  const text = d?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n');
  if (!text) throw new Error('AI provider returned no usable text.');
  return { text, model: 'gemini-2.0-flash', disclaimer: 'This is educational analysis, not financial advice.' };
}

/* ---------- router ---------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });

    const origin = request.headers.get('Origin');
    if (env.ALLOWED_ORIGIN && origin && origin !== env.ALLOWED_ORIGIN) {
      return json(env, { error: 'Origin not allowed.' }, 403);
    }
    if (!authOk(env, url)) return json(env, { error: 'Missing or invalid access token.' }, 401);

    try {
      if (url.pathname === '/health') {
        return json(env, {
          ok: true,
          serverTime: Date.now(),
          providers: {
            marketData: env.TWELVEDATA_KEY ? 'twelvedata' : null,
            calendar: env.NEWS_FEED_URL ? 'configured' : null,
            ai: env.GEMINI_KEY ? 'gemini' : null
          }
        });
      }

      if (url.pathname === '/ohlc') {
        const symbol = url.searchParams.get('symbol') || '';
        const interval = url.searchParams.get('interval') || '';
        const outputsize = Math.min(5000, Math.max(50, parseInt(url.searchParams.get('outputsize') || '300', 10)));
        if (!SYMBOLS.has(symbol)) return json(env, { error: 'Unsupported symbol.' }, 400);
        if (!TF_MAP[interval]) return json(env, { error: 'Unsupported interval.' }, 400);

        // Edge cache keyed by the request, refreshed well inside one candle.
        const cache = caches.default;
        const cacheKey = new Request(url.toString(), request);
        const hit = await cache.match(cacheKey);
        if (hit) {
          const cached = await hit.json();
          return json(env, { ...cached, cached: true });
        }

        const candles = await fetchOhlc(env, symbol, interval, outputsize);
        const payload = { provider: 'twelvedata', symbol, interval, fetchedAt: Date.now(), candles };
        const ttl = Math.max(60, Math.floor(TF_MS[interval] / 4000));
        ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(payload), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + ttl }
        })));
        return json(env, { ...payload, cached: false });
      }

      if (url.pathname === '/calendar') {
        return json(env, await fetchCalendar(env));
      }

      if (url.pathname === '/ai/explain' && request.method === 'POST') {
        const body = await request.json();
        if (!body || typeof body.facts !== 'object') return json(env, { error: 'facts object required.' }, 400);
        const size = JSON.stringify(body.facts).length;
        if (size > 20000) return json(env, { error: 'Fact sheet too large.' }, 413);
        return json(env, await explain(env, body.facts));
      }

      return json(env, { error: 'Not found.' }, 404);
    } catch (err) {
      return json(env, { error: String(err && err.message || err).slice(0, 300) }, 502);
    }
  }
};
