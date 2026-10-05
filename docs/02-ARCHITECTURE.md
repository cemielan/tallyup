# Architecture

## 1. Chosen stack

| Layer | Choice | Why |
|---|---|---|
| Compute | **Cloudflare Workers** | Free plan with no card required, and it **does not spin down when idle**, so there is no cold start for whoever opens a link. |
| HTTP framework | **Hono** | Small, first-class Workers support, built-in CORS, body-limit and secure-header middleware. |
| Database | **Cloudflare D1** (SQLite) | Bound directly to the Worker. Stores ciphertext, edit-token hashes, claims and rate-limit counters. Nothing relational about the data needs Postgres. |
| ORM | **Drizzle** | Readable SQL, good D1 support. Generates `migrations/` from `src/schema.ts`. |
| Validation | **Zod** | Validates API bodies on the server and the decrypted event in the browser. Also the source of the OpenAPI document. |
| Encryption | **WebCrypto AES-256-GCM**, in the browser | Native, audited, no dependency. See Security §2. |
| Frontend | **Svelte 5 + Vite**, built to `dist/` and served as **Workers Static Assets** | Svelte's compiler output is small, and its built-in transitions cover most of the motion. Same origin as the API, one deploy, and static requests cost nothing. |
| PWA | Hand-written `manifest.webmanifest` + `sw.js` (about 50 lines) | A plugin plus Workbox would replace 50 readable lines with a dependency tree. The trade-off is recorded in `sw.js`. |
| OCR | **Tesseract.js** (Apache-2.0), self-hosted under `/ocr` | Runs in a Web Worker on the device. Its worker, LSTM WASM builds and `eng` + `ind` language data are copied from `node_modules` by `scripts/copy-ocr.mjs`. |
| Celebration | **canvas-confetti** (ISC) | One function call. Run without its worker so the CSP stays strict. |
| Split math | **`debt-simplify`** workspace package | Zero dependencies. Runs in the browser. |
| Testing | **Vitest**, twice | API tests run inside the real Workers runtime (`@cloudflare/vitest-pool-workers`). The browser logic (split math, parser, crypto, routing) runs under Node. |
| CI/CD | **GitHub Actions** + `wrangler-action` | Typecheck, build, test with coverage, then migrate and deploy. |

## 2. How a split flows

```
 Host's phone (PWA)                                       Cloudflare
 ──────────────────                                       ──────────
 photo ─► Tesseract (Web Worker, on device) ─► text
 text ─► receipt-parser ─► items, tax, service
 host edits bills, taps who had what
 debt-simplify ─► per-person shares, fewest transfers
 event JSON ─► AES-256-GCM (fresh key) ─► {ciphertext, iv}
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

These numbers come from Cloudflare's Workers limits documentation (free
plan) at research time. **Re-verify them before relying on any of them.**

| Resource | Free limit | What it means for Tallyup |
|---|---|---|
| Requests | 100,000/day | API calls only. Opening an event is two calls (share + claims) and a save is one. Static assets do not count. |
| CPU per request | **10 ms**, not raisable on Free | No longer a pressure point. The server does no hashing beyond one SHA-256 and no math. All arithmetic runs in the browser. |
| Subrequests | 50 per request | Every handler uses at most three D1 statements. |
| KV writes | 1,000/day | The reason rate-limit counters live in D1 rather than KV. No KV namespace is bound. |
| D1 storage | ~5 GB | A share is capped at 48,000 characters of ciphertext. Even at that cap, 5 GB holds roughly 100,000 live events, and the 30-day expiry keeps the set bounded. |
| Worker script size | 3 MB compressed | Hono + Drizzle + Zod. The PWA and OCR files are static assets and do not count. |
| Static asset file size | 25 MiB per file | The largest OCR file is about 3.8 MB. |
| Static asset requests | Free, unlimited | The PWA shell, the bundles and the 8 MB of OCR data cost nothing to serve. |
| Cron triggers | Available on Free | One daily sweep. |

### Upgrade triggers

| If this happens | Cheapest mitigation |
|---|---|
| Sustained traffic near 100k API requests/day | Workers Paid ($5/month, 10M requests). |
| D1 writes from rate-limit counters become the bottleneck | Durable Objects counters (requires Workers Paid). |
| An event needs more than Rp 50.000.000 in one bill | Move the library's proportional `distribute` to BigInt. The cap exists because floating-point products must stay under 2^53 to stay exact (`ponytail:` note in `web/src/lib/doc.ts`). |
| The service worker cache grows noticeably | Generate a precache list at build time and delete old entries. See the `ponytail:` note in `web/public/sw.js`. |

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
