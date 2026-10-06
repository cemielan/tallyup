# Deployment

Everything here fits Cloudflare's free plan. The plan never bills; when a
daily limit is used up, the app pauses until 00:00 UTC (07:00 WIB).

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

cp .dev.vars.example .dev.vars   # local secrets: Turnstile test key + a pass-signing key
npm run db:migrate:local         # create the local D1 schema
npm run dev:api                  # builds the PWA, then API + PWA on http://localhost:8787
```

That is a complete local instance: open <http://localhost:8787>. The
browser check uses Cloudflare's always-pass test keys locally, so you never
see a challenge.

For UI work with hot reload, run Vite as well, in a second terminal:

```bash
npm run dev                      # http://localhost:5173, proxies /v1 to :8787
```

Things to know:

- `predev` and `prebuild` run `scripts/copy-ocr.mjs`, which copies
  Tesseract's files into `web/public/ocr/` (gitignored). If scanning fails
  locally with a 404 on `/ocr/...`, run it by hand.
- The service worker registers only in production builds. That is why
  `dev:api` serves the built app, so you can test offline behaviour there.
- The browser check loads a script from `challenges.cloudflare.com`, so
  creating an event needs internet access, even locally.

### Coming from the old account-based schema

The migrations were reset with the revamp, and `0000_init.sql` now creates
the shares tables. A local database that already applied the *old*
`0000_init.sql` looks up to date to Wrangler while missing every new table.
Delete the local state and migrate again:

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
| `wrangler.toml` `[vars]` | `ENVIRONMENT`, and `DB_SOFT_LIMIT_MB` (450): the database size at which new events are refused. |
| `wrangler.toml` `[triggers]` | Daily sweep at 03:00 UTC. It is set in both the top-level and `[env.production]` blocks, because environments do not inherit triggers. |
| `wrangler.toml` `[assets]` | `./dist`, produced by `npm run build`. |
| Worker secrets | `TURNSTILE_SECRET` (the Turnstile widget's secret key) and `PASS_SECRET` (signs client passes). Neither can read user data. Local values come from `.dev.vars`; production values come from `wrangler secret put`. |
| Build variable | `VITE_TURNSTILE_SITE_KEY`, the widget's public sitekey, baked into the PWA at build time. When it is unset, the build falls back to the always-pass test key, which a production secret rejects. A missing variable shows up immediately as "browser check failed". |

## 4. Production deployment

### Step 1: create the D1 database, near your users

```bash
npx wrangler d1 create tallyup-db --location=apac
```

The database lives in one region for good. Every API call travels to it,
so put it near Indonesia (`apac`); a US or EU location adds a few hundred
milliseconds to each call.

Paste the printed `database_id` into **both** D1 blocks in `wrangler.toml`:
`[[d1_databases]]` and `[[env.production.d1_databases]]`. Both ship with the
placeholder `REPLACE_WITH_YOUR_D1_DATABASE_ID`, and a deploy that still has
it fails at bind time.

### Step 2: apply migrations to the remote database

```bash
npm run db:migrate:remote
```

Wrangler lists pending migrations and asks before it writes. This is the
only step that changes data, and the only one `wrangler rollback` will not
undo.

### Step 3: create the Turnstile widget

In the Cloudflare dashboard, open **Turnstile → Add widget**:

- **Hostnames:** your Worker's hostname, `tallyup.<your-subdomain>.workers.dev`.
  Add your custom domain later if you attach one (§9).
- **Widget mode:** Managed. It stays invisible for almost everyone and asks
  for a click only when unsure.

Copy the **sitekey** (public) and the **secret key**.

### Step 4: set the production secrets

```bash
npx wrangler secret put TURNSTILE_SECRET --env production   # paste the Turnstile secret key
openssl rand -base64 32                                      # generate a pass-signing key...
npx wrangler secret put PASS_SECRET --env production        # ...and paste it here
```

Secrets are stored encrypted on Cloudflare and never enter `wrangler.toml`
or git. Changing `PASS_SECRET` later is safe: every device silently runs
the browser check again on its next create or claim.

### Step 5: deploy

```bash
npm run typecheck && npm test
VITE_TURNSTILE_SITE_KEY=<your-sitekey> npm run deploy   # build + wrangler deploy --env production
```

**Always deploy with `--env production`** (the `deploy` script does it for
you). Both configs use `name = "tallyup"`, so a bare `wrangler deploy`
overwrites the same Worker with `ENVIRONMENT = "development"`.

### Step 6: verify

```bash
BASE=https://tallyup.<your-subdomain>.workers.dev

curl -s $BASE/health                                   # {"status":"ok","environment":"production"}
curl -sI $BASE/ | grep -i content-security-policy      # _headers applied to the PWA
curl -s -X POST $BASE/v1/shares -H 'Content-Type: application/json' \
  -d '{"ciphertext":"c21va2U","iv":"AAAAAAAAAAAAAAAA"}' # 401 PASS_REQUIRED: the pass guard is live
```

Then open the site on a phone and run one full event: create it, scan a
receipt, share it, open the link in a private window, claim a payment, and
confirm it.

| Symptom | Usual cause |
|---|---|
| "The browser check failed" on every create | The sitekey and secret are from different widgets, `VITE_TURNSTILE_SITE_KEY` was not set at build, or the widget's hostnames don't include the site. |
| `500` on create or claim | Remote migrations not applied (Step 2), or a secret not set (Step 4). |

## 5. CI/CD

- `.github/workflows/ci.yml` runs on every PR and every push to `main`:
  typecheck, build, tests with coverage, then `npm audit` (report only).
- `.github/workflows/deploy.yml` runs on every push to `main`. It repeats
  the checks, builds, applies remote migrations and deploys with
  `--env production`. It needs:
  - **Repository secrets** `CLOUDFLARE_API_TOKEN` (permissions: Workers
    Scripts Edit, D1 Edit) and `CLOUDFLARE_ACCOUNT_ID`.
  - **Repository variable** `TURNSTILE_SITE_KEY`. It is public, so it is a
    variable rather than a secret.
  - A GitHub environment named `production`.

  The Worker secrets from Step 4 persist across deploys and are not needed
  in GitHub.

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

- **D1 rows written per day.** This is the free-tier number that moves
  first (about 45 per event, Architecture §3). Past about 60,000 a day,
  plan the move to Workers Paid.
- **`rate_limited` log lines,** grouped by `scope`. Many `create` or `claim`
  hits mean real users are being blocked; check whether the limits in
  Security §3 need raising.
- **`challenge_failed` log lines.** A spike with `invalid-input-response`
  is usually bots. A steady stream from launch day is usually a
  misconfigured sitekey.
- **Cron trigger runs.** A failing sweep shows up as storage growth.

## 9. Before you share it publicly

Run through this once, after the first production deploy:

- [ ] **Step 6 checks pass** on the live URL, including the
      `content-security-policy` header.
- [ ] **A real phone run:** create, scan, share, open in a private window,
      claim, and confirm. Do it on Android Chrome and on iPhone Safari, both
      in the browser and installed to the Home Screen.
- [ ] **Edge protection** (Security §3). It stops floods before they reach
      the Worker, so blocked requests don't use up the daily budget:
  1. Attach a custom domain: Workers → tallyup → Settings → Domains &
     Routes. It is free to attach; only registering the domain costs money.
  2. Add the custom domain to the Turnstile widget's hostnames.
  3. Security → WAF → Rate limiting rules: requests whose path starts with
     `/v1/`, counted per IP, blocked above about 100 requests per
     10 seconds. The free plan includes one simple rule; check which
     options it offers in the dashboard.
  4. Security → Bots → Bot Fight Mode: on. Afterwards, run the phone test
     again. If API calls start failing for real browsers, turn it off; the
     rate-limiting rule and Turnstile still protect the app.
  5. Set `workers_dev = false` in `wrangler.toml` and deploy, so the
     `*.workers.dev` address can't be used to go around the domain's
     rules.
- [ ] **Watch usage daily for the first week.** The Free plan never bills,
      but it does stop. Watch the Workers and D1 usage pages and the log
      lines in §8. The numbers that mean "upgrade" are in Architecture §3.
- [ ] **The cron sweep has run once.** It appears under the Worker's Cron
      Triggers tab the morning after deploy.
- [ ] **A privacy note on the site.** It says what is stored (encrypted
      events, for 30 days), what is not (photos, plaintext), and who can
      see bank details (anyone with the link, until everyone has paid).
      Events hold names and bank account numbers, which are personal data
      even when encrypted.
- [ ] **If this runs as a BINUS service,** route it through the IT
      Division's technology and security review before announcing it. The
      review covers the Cloudflare account, the domain, Turnstile and the
      privacy note.
