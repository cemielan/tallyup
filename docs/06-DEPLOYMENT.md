# Deployment

Target: `git clone` to a running local instance in under 10 minutes
(NFR-303). This doc is the thing that promise is measured against —
keep it accurate as the project evolves.

## 1. Prerequisites (all free)

- Node.js 20+
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free, no
  card required for the Workers Free plan)
- A [GitHub account](https://github.com) (free, for CI/CD and public
  repo hosting)
- The Wrangler CLI: `npm install -g wrangler`

## 2. Local setup

```bash
git clone <your-repo-url>
cd tallyup
npm install

# Authenticate Wrangler with your Cloudflare account (opens a browser)
wrangler login

# Create the D1 database (one-time, per Cloudflare account)
wrangler d1 create tallyup-db
# Copy the returned database_id into wrangler.toml under [[d1_databases]]

# Apply the schema locally
wrangler d1 migrations apply tallyup-db --local

# Copy the example env file and fill in a local JWT secret
cp .dev.vars.example .dev.vars
# Generate a secret: openssl rand -base64 32

# Run it
npm run dev
```

Local dev runs on Miniflare (Cloudflare's local Workers runtime) — this
is not a Node approximation, it's the same isolate model as production,
which is exactly why local behavior around things like the 10ms CPU
budget is meaningfully representative (see Architecture §4).

## 3. Verifying the flow (NFR-304)

```bash
# Register
curl -X POST http://localhost:8787/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"correct horse battery staple","displayName":"Alice"}'

# Login
curl -X POST http://localhost:8787/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"correct horse battery staple"}'
# → save the accessToken from the response

# Create a group
curl -X POST http://localhost:8787/v1/groups \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Bali Trip"}'

# ...add an expense, then fetch the settlement plan:
curl http://localhost:8787/v1/groups/<groupId>/settlements/suggested \
  -H "Authorization: Bearer <accessToken>"
```

The full version of this (with every step filled in) belongs in the
README once the API is built — this doc has the shape, the README has
the copy-pasteable reality.

## 4. Production deployment

### One-time setup

```bash
# Create the production D1 database (or reuse the one from step 2 —
# your call whether local dev and production share a database instance;
# for a portfolio project sharing is fine, just be aware seed/test data
# will be visible in the "real" deployment)
wrangler d1 migrations apply tallyup-db --remote

# Set production secrets (never in wrangler.toml, never in git)
wrangler secret put JWT_SECRET
```

### Deploying

```bash
wrangler deploy
```

That's it — no server to provision, no container to build, no cold
start to wait out on the first request after deploy (Architecture §1).

### Custom domain (optional)

If you own a domain already on Cloudflare, attaching it to the Worker
costs nothing extra beyond whatever you already pay for the domain
itself — add a route in the Cloudflare dashboard under
Workers → your worker → Triggers → Custom Domains.

## 5. CI/CD (GitHub Actions)

Two workflows, both free for public repositories:

**`.github/workflows/ci.yml`** — runs on every PR:
1. `npm ci`
2. `npm run lint`
3. `npm run typecheck`
4. `npm test` (Vitest against the Workers runtime pool)

This is what NFR-404 requires as a merge gate — configure branch
protection on `main` to require this workflow to pass.

**`.github/workflows/deploy.yml`** — runs on merge to `main`:
1. Same checks as CI (never deploy something that didn't pass CI, even
   if it somehow got merged)
2. `wrangler deploy` using [Cloudflare's official `wrangler-action`](https://github.com/cloudflare/wrangler-action),
   authenticated via a `CLOUDFLARE_API_TOKEN` stored as a GitHub Actions
   secret (create a scoped token in the Cloudflare dashboard — Workers
   Edit permission only, not a global API key).

## 6. Monitoring usage against free-tier limits

Cloudflare's dashboard (Workers → your worker → Metrics) shows requests,
CPU time percentiles, and errors for free. Check this periodically
against the budget table in `docs/02-ARCHITECTURE.md` §3 — specifically
watch:

- **p99 CPU time** — if it's creeping toward 10ms, that's the signal to
  profile before it becomes an Error 1102 in production, not after.
- **KV write count** — the tightest free-tier number in the whole stack
  (1,000/day). If the rate limiter's write pattern is wrong, this is
  where it'll show up first.

## 7. Backups

D1 has no automatic point-in-time backup on the free tier. Set up a
simple periodic export instead:

```bash
wrangler d1 export tallyup-db --remote --output=backup-$(date +%F).sql
```

Run this manually before any risky migration, and consider a scheduled
GitHub Actions job (using a `schedule` trigger, still free) that exports
and uploads to a free object store (Cloudflare R2's free tier — 10GB —
is the natural choice since it's the same account) on a weekly cadence
once real data exists worth protecting.

## 8. Rollback

`wrangler deployments list` shows recent deployments;
`wrangler rollback <deployment-id>` reverts the Worker code instantly
(this does not undo a database migration — schema rollbacks need their
own down-migration, written and tested alongside the up-migration, not
improvised during an incident).
