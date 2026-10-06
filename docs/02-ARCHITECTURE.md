# Architecture

## 1. Chosen stack

| Layer | Choice | Why |
|---|---|---|
| Compute | **Cloudflare Workers** | Free plan with no card required, and it **does not spin down when idle**, so there is no cold start for whoever opens a link. |
| HTTP framework | **Hono** | Small, first-class Workers support, built-in CORS, body-limit and secure-header middleware. |
| Database | **Cloudflare D1** (SQLite) | Bound directly to the Worker. Stores ciphertext, edit-token hashes, claims and rate-limit counters. Nothing relational about the data needs Postgres. |
| ORM | **Drizzle** | Readable SQL, good D1 support. Generates `migrations/` from `src/schema.ts`. |
| Validation | **Zod** | Validates API bodies on the server and the decrypted event in the browser. |
| Bot check | **Cloudflare Turnstile** (free) | Gates the two anonymous writes. It is exchanged for a signed 24-hour client pass, so limits can count per browser rather than per shared address. Security §3. |
| Encryption | **WebCrypto AES-256-GCM**, in the browser | Native, audited, no dependency. See Security §2. |
| Frontend | **Svelte 5 + Vite**, built to `dist/` and served as **Workers Static Assets** | Svelte's compiler output is small, and its built-in transitions cover most of the motion. Same origin as the API, one deploy, and static requests cost nothing. |
| PWA | Hand-written `manifest.webmanifest` + `sw.js` (about 50 lines) | A plugin plus Workbox would replace 50 readable lines with a dependency tree. The trade-off is recorded in `sw.js`. |
| OCR | **Tesseract.js** (Apache-2.0), self-hosted under `/ocr` | Runs in a Web Worker on the device. Its worker, LSTM WASM builds and `eng` + `ind` language data are copied from `node_modules` by `scripts/copy-ocr.mjs`. |
| Celebration | **canvas-confetti** (ISC) | One function call. Run without its worker so the CSP stays strict. |
| Split math | **`debt-simplify`** workspace package | Zero dependencies. Runs in the browser. |
| Testing | **Vitest**, twice | API tests run inside the real Workers runtime (`@cloudflare/vitest-pool-workers`). The browser logic (split math, parser, crypto, routing) runs under Node. |
| CI/CD | **GitHub Actions** + the locked `wrangler` | Typecheck, build, test with coverage, then migrate and deploy. |

## 2. How a split flows

```
 Host's phone (PWA)                                       Cloudflare
 ──────────────────                                       ──────────
 photo ─► Tesseract (Web Worker, on device) ─► text
 text ─► receipt-parser ─► items, tax, service
 host edits bills, taps who had what
 debt-simplify ─► per-person shares, fewest transfers
 event JSON ─► AES-256-GCM (fresh key) ─► {ciphertext, iv}
 Turnstile (invisible) ─► POST /v1/pass ──────────────► Worker ─► signed 24 h pass
                                   POST /v1/shares ──────► Worker ─► D1: ciphertext,
                                   ◄── {id, editToken}              sha256(editToken)
 local history: {id, key, editToken}

 view link:  https://<host>/#/s/<id>/<key>              ◄─ shared in chat
 host link:  https://<host>/#/e/<id>/<key>/<editToken>  ◄─ kept private

 Friend's phone
 ──────────────
 GET /v1/shares/<id> ─► ciphertext ─► decrypt with <key> from the fragment
 Zod-validate ─► debt-simplify ─► "You pay Ana Rp 63.525" + Ana's bank details
 "I've paid" ─► encrypt claim ─► POST /v1/shares/<id>/claims

 Host's phone
 ────────────
 GET claims ─► decrypt ─► Confirm ─► add settlement to event ─► PUT (edit token)
                                   ─► DELETE claim
```

The fragment (`#...`) is the whole trick. Browsers never put it in a
request line or a Referer header, so the key reaches only the person who
holds the link.

### Routing

All routes are hash routes (`#/`, `#/new`, `#/s/…`, `#/e/…`, `#/h/…`;
see `web/src/lib/links.ts`). The server is never asked for an app route,
so `wrangler.toml` leaves single-page-app fallback off and a mistyped
`/v1/...` still returns a clean 404. When a host link is opened, its edit
token is saved to local history and the URL is replaced with `#/h/<id>`,
taking the token out of the address bar.

## 3. Free-tier budget

Verified against Cloudflare's Workers, D1 and static-asset limits pages on
2026-10-05. **Re-verify before relying on a number. Cloudflare changes
them.**

| Resource | Free limit | Where Tallyup spends it |
|---|---|---|
| Worker requests | **100,000/day**, reset 00:00 UTC (07:00 WIB) | API calls only. Opening an event is **one** request: the share and its claims come back together. |
| Static asset requests | Free and unlimited; they never invoke the Worker | The PWA, its bundles and the 8 MB of OCR data. |
| D1 rows written | **100,000/day**, account-wide. Each index touched counts as an extra row. | Creates, saves, claims, confirmations, the sweep, and one rate-limit counter per write request. **This is the first limit Tallyup hits.** |
| D1 rows read | 5,000,000/day | One share row plus at most 50 claims per open. Not a practical constraint. |
| D1 database size | **500 MB** per database (5 GB per account) | A typical 3-person event is about 600 characters of ciphertext. Creation stops at 450 MB (`DB_SOFT_LIMIT_MB`), which is roughly 400,000 live events. |
| CPU per request | 10 ms, not raisable on Free | One SHA-256 at most. All arithmetic runs in the browser. |
| Queries per request | 50 | Every handler uses three or fewer. |
| Cron triggers | 5 per account, 10 ms CPU | One daily sweep. The deletes run in D1, not on the Worker's CPU. |
| Static asset files | 20,000 per version, 25 MiB each | About 30 files. The largest is 3.8 MB. |

### What one event costs

A typical event: created once, saved twice, four friends opening it twice
each, three "I've paid" claims, three confirmations, and the host checking
back three times.

| | Per event | Free daily budget | Events per day |
|---|---|---|---|
| Worker requests | ~23 | 100,000 | ~4,000 |
| D1 rows written | ~45 | 100,000 | **~2,000** |

**Roughly 2,000 events a day (about 60,000 a month) fit the free tier.** At
an average of five people per event, that is on the order of 10,000 people
splitting a bill every day.

### What happens at the limit

Nothing is ever billed: the Free plan has no overage charges. Instead,
things stop until the daily reset:

| Limit reached | What users see |
|---|---|
| Worker requests | The app still opens, because static assets do not touch the Worker. API calls fail, and the app shows "Tallyup is very busy… your changes are safe on this phone". Drafts are kept locally. |
| D1 rows written | D1 refuses all queries, reads included, until 00:00 UTC. The app shows the same "busy" message. |
| Database size (soft cap) | New events are refused with `503 AT_CAPACITY`. Existing events keep working, and the daily sweep frees space as old events expire. |

### Upgrade triggers

| If this happens | Cheapest mitigation |
|---|---|
| Daily D1 writes regularly pass ~60,000, or requests pass ~60,000 | **Workers Paid, $5/month.** It raises every daily limit above into monthly allowances many times larger and makes the database cap 10 GB. Check current pricing first. After upgrading, raise `DB_SOFT_LIMIT_MB`. |
| One campus or office network hits the per-address backstop | Raise `createBackstop` / `claimBackstop` in `src/middleware.ts`. The per-pass limits still hold each browser to its own quota. |
| Bots fill the database despite Turnstile | Lower the per-pass and per-address create limits, or shorten `PASS_TTL_MS` so each pass buys less. |
| Rate-limit counters become a large share of D1 writes | Move them to the Workers Rate Limiting binding, which keeps no D1 state. Its availability on the Free plan is not documented, so confirm it first. |
| An event needs more than Rp 50.000.000 in one bill | Move the library's proportional `distribute` to BigInt (`ponytail:` note in `web/src/lib/doc.ts`). |
| The service worker cache grows noticeably | Generate a precache list at build time (`ponytail:` note in `web/public/sw.js`). |

## 4. Trade-offs and known limitations

- **History is device-local.** Clearing site data, or Safari evicting
  storage for a site not added to the Home Screen, loses the host's event
  list and edit tokens. The host link is the backup, and the app asks for
  persistent storage when an event is first published.
- **The server cannot enforce content rules.** It can only cap size and
  rate. A client could upload a nonsensical event, and it would only hurt
  the people holding that event's key. The browser validates every
  document it decrypts.
- **The view link is a bearer secret.** Forwarding it forwards access,
  including the bank details. "Reset share link" is the recovery path.
- **Claims are honour-system.** Anyone with the view link can claim to be
  anyone. Only the host's confirmation changes balances.
- **OCR accuracy is limited.** Thermal paper, creases and unusual layouts
  defeat it. The parser is heuristic and tuned for Indonesian receipts. The
  editor, not the scanner, is the source of truth.
- **No live updates.** Workers are request/response. Viewers reload, and
  the host taps "Check for payments".
- **The compatibility date is pinned to the test runner**
  (`wrangler.toml`), so tests and production share runtime semantics.

## 5. Alternatives considered

- **Plaintext storage with server-side balances.** This was the previous
  design: accounts, groups and a REST ledger. It was replaced because
  "no sign-up" and "nothing readable stored" cannot both hold if the
  server computes balances.
- **Data in the URL only, no server.** True zero storage, but the links
  are long and frozen, with no payment tracking. It is rejected because
  payment tracking needs shared state.
- **Cloud OCR or vision models.** More accurate, but the receipt image
  would leave the device (FR-201).
