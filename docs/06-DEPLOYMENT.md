# Deployment

## 1. Prerequisites

- Node.js 20 or newer.
- A Cloudflare account (free). No payment card is needed.
- `npx wrangler login` done once on your machine. Check with
  `npx wrangler whoami`.

## 2. Local development

```bash
git clone <your-repo-url>
cd tallyup
npm install

npm run db:migrate:local     # create the local D1 schema
npm run dev:api              # builds the PWA, then API + PWA on http://localhost:8787
```

That is a complete local instance: open <http://localhost:8787>.

For UI work with hot reload, run Vite as well, in a second terminal:

```bash
npm run dev                  # http://localhost:5173, proxies /v1 to :8787
```

Two things to know:

- `predev` and `prebuild` run `scripts/copy-ocr.mjs`, which copies
  Tesseract's files into `web/public/ocr/` (gitignored). If scanning
  fails locally with a 404 on `/ocr/...`, run it by hand.
- The service worker registers only in production builds. That is why
  `dev:api` serves the built app, so you can test offline behaviour there.

### Coming from the old account-based schema

The migrations were reset with the revamp, and `0000_init.sql` now creates
the shares tables. A local database that already applied the *old*
`0000_init.sql` will look up to date to Wrangler while missing every new
table. Delete the local state and migrate again:

```bash
rm -rf .wrangler/state/v3/d1
npm run db:migrate:local
```

### Checks

```bash
npm run typecheck        # tsc (Worker) + svelte-check (PWA), warnings fail
npm test                 # API in the Workers runtime + browser logic under Node
npm run test:coverage    # same, with the 80% floor (NFR-501) enforced
npm run build            # PWA into ./dist
```

## 3. Configuration

| Where | What |
|---|---|
| `wrangler.toml` `[vars]` | `ENVIRONMENT` only. |
| `wrangler.toml` `[triggers]` | Daily sweep at 03:00 UTC. It is set in both the top-level and `[env.production]` blocks, because environments do not inherit triggers. |
| `wrangler.toml` `[assets]` | `./dist`, produced by `npm run build`. |
| Secrets | None. The Worker holds no key that could read user data. |

## 4. Production deployment

### Step 1: create the D1 database

```bash
npx wrangler d1 create tallyup-db
```

Paste the printed `database_id` into **both** D1 blocks in `wrangler.toml`:
`[[d1_databases]]` and `[[env.production.d1_databases]]`. Both ship with the
placeholder `REPLACE_WITH_YOUR_D1_DATABASE_ID`, and a deploy that still has
it fails at bind time.

Local development and production share this one database unless you create
a second one for production. Sharing is fine while you are the only user;
just remember that events you create in development are visible in
production.

### Step 2: apply migrations to the remote database

```bash
npm run db:migrate:remote
```

Wrangler lists pending migrations and asks before it writes. This is the
only step that changes data, and the only one `wrangler rollback` will not
undo.

### Step 3: deploy

```bash
npm run typecheck && npm test
npm run deploy               # = npm run build && wrangler deploy --env production
```

**Always deploy with `--env production`** (the `deploy` script does it for
you). Both configs use `name = "tallyup"`, so a bare `wrangler deploy`
overwrites the same Worker with `ENVIRONMENT = "development"`.

### Step 4: verify

```bash
BASE=https://tallyup.<your-subdomain>.workers.dev

curl -s $BASE/health                                    # {"status":"ok","environment":"production"}
curl -s $BASE/v1/openapi.json | head -c 200             # OpenAPI served
curl -sI $BASE/ | grep -i content-security-policy       # _headers applied to the PWA
curl -s -X POST $BASE/v1/shares -H 'Content-Type: application/json' \
  -d '{"ciphertext":"c21va2U","iv":"AAAAAAAAAAAAAAAA"}'  # 201: D1 bound, migrations applied
```

Then open the site on a phone and run one full event: create it, scan a
receipt, share it, open the link in a private window, claim a payment, and
confirm it.

A `500` on the POST almost always means the remote migrations were not
applied.

## 5. CI/CD

- `.github/workflows/ci.yml` runs on every PR and every push to `main`:
  typecheck, build, tests with coverage, then `npm audit` (report only).
- `.github/workflows/deploy.yml` runs on every push to `main`. It repeats
  the checks, builds, applies remote migrations and deploys with
  `--env production`.
  - It needs repository secrets `CLOUDFLARE_API_TOKEN` (permissions:
    Workers Scripts Edit, D1 Edit) and `CLOUDFLARE_ACCOUNT_ID`.
  - It needs a GitHub environment named `production`.

## 6. Rollback

```bash
npx wrangler deployments list --env production
npx wrangler rollback <deployment-id> --env production
```

Rollback restores code and assets, not data. Keep migrations
backward-compatible: add columns rather than renaming them. Then the
previous version still runs against the new schema.

## 7. Backups

The data is ciphertext the operator cannot read, and it expires after 30
days, so a backup protects availability, not content. To take one:

```bash
npx wrangler d1 export tallyup-db --remote --env production --output backup-$(date +%F).sql
```

`backup-*.sql` is gitignored. D1 also offers point-in-time restore
(Time Travel) from the Cloudflare dashboard.

## 8. Monitoring

Workers observability is enabled in `wrangler.toml`. In the dashboard,
watch:

- **4xx/5xx rates on `/v1/shares`.** A rise in `422` usually means a client
  build is sending a stale shape.
- **D1 rows written per day.** This is the free-tier number that moves
  first (about 45 per event, Architecture §3). Past about 60,000 a day,
  plan the move to Workers Paid.
- **Cron trigger runs.** A failing sweep shows up as storage growth.

## 9. Before you share it publicly

Run through this once, after the first production deploy:

- [ ] **Step 4 checks pass** on the live URL, including the
      `content-security-policy` header.
- [ ] **A real phone run:** create, scan, share, open in a private window,
      claim, and confirm. Do it on Android Chrome and on iPhone Safari, both
      in the browser and installed to the Home Screen.
- [ ] **A notification for usage.** The Free plan never bills, but it does
      stop. Check the Workers and D1 usage pages daily for the first week.
      The numbers to watch, and the point at which to upgrade, are in
      Architecture §3.
- [ ] **The cron sweep has run once.** It appears under the Worker's Cron
      Triggers tab the morning after deploy.
- [ ] **A privacy note on the site.** It says what is stored (encrypted
      events, for 30 days), what is not (photos, plaintext), and who can
      see bank details (anyone with the link). Events hold names and bank
      account numbers, which are personal data even when encrypted.
- [ ] **If this runs as a BINUS service,** route it through the IT
      Division's technology and security review before announcing it. The
      review covers the Cloudflare account, the domain and the privacy note.

A custom domain is optional. `tallyup.<subdomain>.workers.dev` is free and
has HTTPS out of the box. A domain you own can be attached for free in the
Cloudflare dashboard (Workers → your Worker → Settings → Domains & Routes).
Only the domain registration itself costs money.
