# EdgePilot

A selective, evidence-based forex and gold signal assistant. It is built to say
**NO TRADE** most of the time, and to refuse to show a win rate it cannot justify.

EdgePilot is an educational analysis tool. It does not provide financial advice,
does not guarantee accuracy, and cannot predict profit.

---

## What is in here

```
Every file sits at the repository root. There are no subfolders, so a phone
upload cannot flatten the structure and break the script paths.

index.html                  app shell, six screens
styles.css                  graphite / navy interface
util.js                     instruments, sessions, formatting, escaping, Wilson + Beta shrinkage
indicators.js               EMA, ATR, ADX, RSI, MACD, Donchian, pivots, structure, Supertrend
engine.js                   the six-stage pipeline and the capped scoring model
stats.js                    performance, calibration, Bayesian strategy weights, resolution
backtest.js                 walk-forward with in-sample / out-of-sample separation
store.js                    IndexedDB, settings, secret-stripping, backup validation
api.js                      backend client (no credentials ever touch this file)
ui.js                       rendering, all output escaped
app.js                      wiring, fetch policy, scan loop
sw.js                       app shell cache only, never market data
manifest.webmanifest        PWA manifest
icon-192.png / icon-512.png maskable PWA icons
apple-touch-icon.png        iOS home screen icon
favicon-32.png              browser tab icon
screenshot-narrow.png       shown in the Android install dialog
edgepilot-worker.js         Cloudflare Worker backend (paste into Cloudflare, NOT served by Pages)
```

## Two ways to get market data

**Backend mode (default).** A Cloudflare Worker holds your provider key. The app
only knows the worker's address, which is not a credential. This is the mode the
spec asks for and the only one fit for a published or sold app.

**Direct mode.** The browser calls TwelveData itself using a key stored in this
browser. It is faster to set up and needs no worker, but the key is readable by
anyone who opens the site's code, and they can spend your daily quota. Direct
mode also has no economic calendar and no AI explanations, so news risk reads
UNKNOWN — which the engine treats as unverified, not cleared.

Switch in **Settings → Data provider**. The key is never written into a backup
file in either mode.

## Architecture, and why it is not one HTML file

Your spec says provider credentials stay server-side and localStorage never holds
a key. GitHub Pages is static, so that requirement forces a second piece: a small
backend. The Cloudflare Worker is that backend. The PWA only ever knows the
worker's address, which is not a secret.

The app is split across files rather than inlined because the engine alone is
roughly a thousand lines of interdependent maths. Editing that inside one file on
a phone is where mistakes come from. Every file still deploys to GitHub Pages
exactly the same way, and median.co wraps a URL, so nothing changes for the APK.

---

## Deploy: backend first

1. Create a Cloudflare account and open Workers.
2. Create a worker and paste `edgepilot-worker.js`.
3. Add secrets under Settings → Variables (encrypt each one):
   - `TWELVEDATA_KEY` — required
   - `GEMINI_KEY` — optional, enables the AI explanation button
   - `ACCESS_TOKEN` — optional, callers must then send `?t=<token>`
4. Add a plain variable `ALLOWED_ORIGIN` set to your Pages origin, e.g.
   `https://ankushchhajed7-cmd.github.io`.
5. Optional: `NEWS_FEED_URL` pointing at a JSON economic calendar.

Or from a machine with wrangler:

```
wrangler secret put TWELVEDATA_KEY
wrangler deploy
```

## Deploy: app

Push the repo, enable GitHub Pages, open the app, go to **Settings → Backend URL**
and paste your worker address. Press **Test connection**. It will tell you which
providers the backend actually has, rather than assuming.

## Install it on your phone

**Android / Chrome / Edge.** Open the Pages URL, go to **Settings → Install**, tap
**Install EdgePilot**. If the button does not appear, use the browser menu and
choose "Install app". The install prompt needs three things, and all three are in
this repo: HTTPS, a manifest with 192px and 512px icons, and a service worker.

**iPhone / Safari.** iOS never fires an install prompt, so the Settings card shows
the manual steps instead: Share button → **Add to Home Screen**. Chrome on iOS
cannot install web apps at all; it has to be Safari.

**As an APK via median.co.** Point median.co at your Pages URL. Set the app icon
to `icon-512.png`, the splash and status bar colour to `#080b10`, and lock
orientation to portrait to match the manifest. Nothing in the code changes.

One thing to know: an installed PWA and the browser tab keep **separate**
IndexedDB storage on some Android versions. Signals and journal entries recorded
in the browser will not automatically appear in the installed app. Export a
backup from one and import it into the other the first time you switch.

---

## The six gates

Every instrument goes through the same pipeline and the app reports where it
stopped. That ladder is the main screen element on the signal page.

| # | Gate | Fails when |
|---|------|-----------|
| 01 | Data quality | stale, duplicated, gapped, insufficient, or zero-range candles |
| 02 | Market regime | classifies TRENDING / RANGING / BREAKOUT / HIGH VOLATILITY, with NEWS RISK and LOW LIQUIDITY as overlays |
| 03 | Higher timeframe bias | D1 and H4 disagree and no reversal strategy is enabled |
| 04 | Setup detection | none of the four patterns are present |
| 05 | Entry confirmation | candle does not confirm, is over 2× ATR, or price sits in the top/bottom 20% of range |
| 06 | Risk filters | net R:R below your floor, stop outside 0.8–3.0× ATR, news window, spread, daily loss limit, cooldown |

Only closed candles are ever used. `nowMs` is passed explicitly through the whole
engine, which is what lets the backtester replay history without look-ahead.

## Three numbers that are not the same thing

- **Setup score** (0–100) — how much independent evidence lines up right now.
  Grouped and capped: bias 20, regime 15, structure 20, trigger 20, stop 10,
  news 10, R:R 5. Inside the trigger group, EMA / MACD / RSI / Supertrend are
  combined with geometric decay and hard-capped at 7 points, so four indicators
  saying the same thing cannot pay four times.
- **Historical win rate** — computed only from resolved signals. Hidden until 30
  exist for the context, and shown with the sample size and a 90% Wilson interval.
- **Model confidence** — the win rate that a score band actually produced,
  shrunk toward the base rate. Hidden until 40 resolved signals exist overall and
  15 in the band.

If the sample is thin, the app shows a progress bar toward the threshold instead
of a number. That is deliberate.

## What "resolved" means

A signal is not a trade until price trades into the entry zone. If it never
does, the outcome is `EXPIRED_NO_FILL` and it is excluded from the win rate
entirely. When one candle contains both the stop and the target, the run counts a
loss. R multiples are net of spread, commission and slippage.

## Expect the Performance Lab to be empty at first

It will stay empty for weeks. That is the correct behaviour for a spec that
forbids fake historical performance. There is no seed data, no demo trades, and
no placeholder percentages. The three ways it fills:

1. Generate signals, press **Check open signals** in the journal, let them resolve.
2. Run a walk-forward backtest. Those results are stored and displayed
   **separately** and never merge into the live record.
3. Import a backup from another device.

---

## Honest limitations

- **The engine is very selective.** On a synthetic 900-candle series it produced
  roughly one tradeable signal per 200 bars. On real data the rate depends on the
  instrument, but expect few signals. If you want more, lower **Minimum setup
  score** in Settings — do not loosen the risk filters.
- **Walk-forward folds need a long history.** With a selective engine and a free
  data plan, four folds will often report "fewer than 5 signals" and skip. Fetch
  more history or widen the instrument list before drawing conclusions.
- **No historical economic calendar.** Backtests run with the news filter
  inactive, and the report says so. Live results will differ from backtests for
  that reason alone.
- **Position size is an estimate.** Contract sizes vary by broker, especially on
  BTC/USD. Confirm before sending an order.
- **Volume on spot FX is tick volume**, not real traded volume. It contributes at
  most 5 of the 20 trigger points, and defaults to neutral when missing.
- **Costs default to broker-generic values.** Replace them in Settings with your
  own Exness spreads or every R:R figure will be optimistic.
- **Data budget.** A timeframe is only refetched once its next candle could have
  closed. A five-instrument scan on H1 costs roughly 5–15 provider credits per
  hour, so a free 800/day plan is comfortable.

## Security posture

- No API key, bot token or payment secret is stored in localStorage. Settings are
  passed through a stripper that refuses any field whose name looks like a
  credential, and the same stripper runs on import.
- Backups contain signals, journal entries and non-secret settings only. The
  backend URL is removed on export.
- Imports are validated field by field; malformed records are counted and dropped.
- All external and AI-generated text is escaped before rendering.
- The service worker caches the app shell only. Caching market data there would
  quietly defeat the staleness gate.

## AI behaviour

The AI endpoint receives a narrow fact sheet the engine already computed and a
system prompt that forbids inventing prices, indicators, news or statistics,
forbids changing levels, forbids overriding filters, and requires cautious
phrasing. Where a statistic is unavailable, the fact sheet says so explicitly and
the model is told to repeat that rather than estimate. Returning "no trade" is
allowed. Every response ends with the educational-analysis disclaimer.

## Accessibility

Real checkboxes and labels throughout, `role="tablist"` navigation with
`aria-selected`, modals with `role="dialog"`, `aria-modal`, focus trap and Escape
to close, visible focus rings, live regions for the status strip and error
banners, a skip link, 44px minimum touch targets, and `prefers-reduced-motion`
respected.
