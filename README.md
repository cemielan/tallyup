# Tallyup

**Split the bill. Share one link. No app, no sign-up.**

Tallyup is a split-bill and debt-payment PWA:

1. The host adds the people at the table, then scans the receipt or types it in.
2. The host taps who had what and gets a link that "prints" a receipt.
3. Friends open the link, see what they owe and where to transfer, and tap
   **I've paid**.
4. The host confirms each payment until the receipt reads **ALL SETTLED**.

Two things make it different:

- **The server can't read your events.** Everything is encrypted on the
  device (AES-256-GCM), and the key lives only in the link's `#fragment`,
  which browsers never send to a server.
- **Receipt photos never leave the phone.** OCR runs in the browser.

The sharing API is open. Any client that implements the documented
encryption scheme can create and read Tallyup events.

**Documentation:** start at [`PROJECT_BRIEF.md`](PROJECT_BRIEF.md), then
[requirements](docs/01-REQUIREMENTS.md), [architecture](docs/02-ARCHITECTURE.md),
[data model](docs/03-DATA-MODEL.md), [API spec](docs/04-API-SPEC.md),
[security](docs/05-SECURITY.md), [deployment](docs/06-DEPLOYMENT.md),
[roadmap](docs/07-ROADMAP.md).

## Quick start

```bash
npm install
npm run db:migrate:local
npm run dev:api          # builds the PWA, serves app + API at http://localhost:8787
```

For UI work with hot reload, also run `npm run dev` (Vite on :5173,
proxying `/v1` to :8787).

```bash
npm run typecheck        # Worker (tsc) + PWA (svelte-check)
npm test                 # API in the Workers runtime + browser logic under Node
npm run test:coverage    # with the 80% floor enforced
npm run deploy           # build + wrangler deploy --env production
```

Production setup, CI and rollback are in
[`docs/06-DEPLOYMENT.md`](docs/06-DEPLOYMENT.md).

| URL | What it is |
|---|---|
| `/` | The PWA |
| `/docs` | Interactive API reference |
| `/v1/openapi.json` | OpenAPI document, generated from the Zod schemas |

## How it works

```
phone ─ photo ─► Tesseract (on device) ─► items ─► you tap who had what
      ─ debt-simplify ─► shares, fewest transfers
      ─ AES-256-GCM ─► POST /v1/shares ─► D1 stores ciphertext only

link:  https://…/#/s/<id>/<key>     the key never reaches the server
```

- **Split rules:** a shared item is divided equally among the people who
  had it. Tax, service and discount follow what each person ordered. Every
  bill sums to the exact rupiah.
- **Payments:** a viewer's "I've paid" is an encrypted claim. The host
  confirms it, which records the payment in the event, or declines it. A
  viewer can never clear their own debt.
- **Payment details:** each person can optionally show bank name, account
  number and account holder. Anyone with the link sees them.
- **History:** stored on the host's device. The host link (shown once,
  after printing) is the backup.
- **Expiry:** 30 days after the last edit.

## Layout

```
src/                     Cloudflare Worker: Hono API over D1
  routes/shares.ts       the seven /v1/shares endpoints
  middleware.ts          rate limits, share loading, edit-token check
  index.ts               app, CORS, error envelope, daily sweep
web/                     the PWA (Svelte 5 + Vite)
  src/lib/               crypto, document schema, split math, OCR, parser, API client
  src/views/             Home, Editor (host), Viewer (guest)
  src/components/        Receipt, BillCard, MoneyInput
  public/                manifest, service worker, _headers (CSP), icons
packages/debt-simplify/  split and settlement arithmetic, zero dependencies
test/                    API tests (Workers runtime) and test/web (browser logic)
scripts/copy-ocr.mjs     self-hosts Tesseract's worker, WASM and language data
```

## Stack

Cloudflare Workers + D1 (free tier), Hono, Drizzle, Zod, Svelte 5, Vite,
Tesseract.js, canvas-confetti and Vitest. The reasoning, and the free-tier
numbers behind it, are in [`docs/02-ARCHITECTURE.md`](docs/02-ARCHITECTURE.md).
