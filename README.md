# Tallyup

A REST API for tracking shared group expenses and working out the minimum set
of payments that settles everyone up. Any frontend — web, mobile, CLI, a chat
bot — can be built against it; the API is the deliverable.

The settlement arithmetic itself lives in a separate zero-dependency library,
[`debt-simplify`](#the-debt-simplify-dependency), consumed here as an ordinary
npm dependency. Tallyup is the application around it: users, groups,
persistence, auth, HTTP.

**Documentation:** start at [`PROJECT_BRIEF.md`](PROJECT_BRIEF.md), then
[requirements](docs/01-REQUIREMENTS.md), [architecture](docs/02-ARCHITECTURE.md),
[data model](docs/03-DATA-MODEL.md), [API spec](docs/04-API-SPEC.md),
[security](docs/05-SECURITY.md), [deployment](docs/06-DEPLOYMENT.md),
[roadmap](docs/07-ROADMAP.md).

## What this demonstrates

- **A published library consumed by a real application** — the debt
  arithmetic is a versioned dependency, not inlined logic.
- **Security as a requirement, not a retrofit** — PBKDF2 password hashing
  over WebCrypto, refresh-token rotation with reuse detection, a membership
  check applied as middleware to every group-scoped route, strict Zod
  validation that rejects unknown fields, per-IP and per-user rate limits.
  See [`docs/05-SECURITY.md`](docs/05-SECURITY.md).
- **A stack that genuinely costs nothing at this scale** — Cloudflare Workers
  plus D1, chosen because edge compute with a directly bound database has no
  cold start and no idle spin-down, not because it is a toy.
- **Documentation written before the code** — every requirement carries an ID
  (`FR-xxx` / `NFR-xxx`) that commits and tests can cite.

## Stack

| Layer | Choice |
|---|---|
| Compute | Cloudflare Workers |
| Framework | Hono |
| Database | Cloudflare D1 (SQLite at the edge) |
| ORM | Drizzle |
| Validation | Zod (also the source of the OpenAPI document) |
| Auth | JWT access tokens + opaque rotating refresh tokens, WebCrypto only |
| Tests | Vitest running inside the Workers runtime |

## Quick start

```bash
git clone <your-repo-url>
cd tallyup
npm install

# Authenticate Wrangler with your Cloudflare account (opens a browser)
npx wrangler login

# Create the database, then paste the returned id into wrangler.toml
npx wrangler d1 create tallyup-db

# Apply the schema to the local database
npm run db:migrate:local

# Create a local signing secret
cp .dev.vars.example .dev.vars
openssl rand -base64 32   # paste into JWT_SECRET in .dev.vars

npm run dev               # http://localhost:8787
npm test                  # runs inside the real Workers runtime
```

Full setup, production deployment, backups and rollback:
[`docs/06-DEPLOYMENT.md`](docs/06-DEPLOYMENT.md).

Interactive API reference once running: <http://localhost:8787/docs>
(the raw document is at `/v1/openapi.json`, generated from the same Zod
schemas the routes validate with).

## A full flow, end to end

Every amount is an integer in **minor currency units** — `1050` means $10.50.
The API never accepts or returns decimal money.

```bash
BASE=http://localhost:8787/v1

# 1. Register two people
curl -sX POST $BASE/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"a-long-enough-passphrase-42","displayName":"Alice"}'

curl -sX POST $BASE/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"bob@example.com","password":"a-long-enough-passphrase-42","displayName":"Bob"}'

# 2. Log in as Alice and keep the access token
ALICE=$(curl -sX POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"a-long-enough-passphrase-42"}')
ALICE_TOKEN=$(echo "$ALICE" | jq -r .accessToken)
ALICE_ID=$(echo "$ALICE" | jq -r .user.id)

BOB=$(curl -sX POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"bob@example.com","password":"a-long-enough-passphrase-42"}')
BOB_TOKEN=$(echo "$BOB" | jq -r .accessToken)
BOB_ID=$(echo "$BOB" | jq -r .user.id)

# 3. Alice creates a group and shares the invite code
GROUP=$(curl -sX POST $BASE/groups \
  -H "Authorization: Bearer $ALICE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Bali Trip"}')
GROUP_ID=$(echo "$GROUP" | jq -r .id)
INVITE=$(echo "$GROUP" | jq -r .inviteCode)

# 4. Bob joins with it
curl -sX POST $BASE/groups/join \
  -H "Authorization: Bearer $BOB_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"inviteCode\":\"$INVITE\"}"

# 5. Alice pays for the hotel, split equally
curl -sX POST $BASE/groups/$GROUP_ID/expenses \
  -H "Authorization: Bearer $ALICE_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"amount\":12000,\"currency\":\"USD\",\"description\":\"Hotel\",
       \"paidBy\":\"$ALICE_ID\",
       \"split\":{\"type\":\"equal\",\"participants\":[\"$ALICE_ID\",\"$BOB_ID\"]}}"

# 6. Who owes what
curl -s $BASE/groups/$GROUP_ID/balances -H "Authorization: Bearer $ALICE_TOKEN"
# → Alice +6000 USD, Bob -6000 USD

# 7. The minimum set of payments that settles the group
curl -s $BASE/groups/$GROUP_ID/settlements/suggested -H "Authorization: Bearer $ALICE_TOKEN"
# → Bob pays Alice 6000 USD

# 8. Bob says he paid; only Alice can confirm she received it
SETTLEMENT=$(curl -sX POST $BASE/groups/$GROUP_ID/settlements \
  -H "Authorization: Bearer $BOB_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"toUserId\":\"$ALICE_ID\",\"amount\":6000,\"currency\":\"USD\"}")

curl -sX POST $BASE/settlements/$(echo "$SETTLEMENT" | jq -r .id)/confirm \
  -H "Authorization: Bearer $ALICE_TOKEN"

# 9. Everyone is square
curl -s $BASE/groups/$GROUP_ID/balances -H "Authorization: Bearer $ALICE_TOKEN"
# → {"balances":[]}
```

## Design notes worth knowing

**Balances are always derived.** Nothing stores a running balance. Every
balance read sums the expense splits and hands them to `calculateBalances`,
so editing or deleting an expense changes the answer with no bookkeeping to
fall out of sync (FR-308).

**Confirming a settlement writes a balancing expense** rather than adjusting
a stored number, which keeps the expense ledger the single source of truth for
who owes what.

**Expense deletion is soft.** Expenses are financial records, so a delete sets
`deleted_at` and drops the row out of balance calculations; it is not removed.

**Split amounts are resolved at write time.** A `percentage` split is turned
into integer amounts when the expense is created, so a later change in the
library's rounding could never retroactively alter a historical expense.

**Currencies never net against each other.** A USD credit does not cancel an
IDR debt; each currency gets its own balance sheet and its own settlement plan
(FR-405).

**Non-members get `404`, not `403`,** on group-scoped routes, so an outsider
cannot tell a group they are excluded from apart from one that does not exist.

## The `debt-simplify` dependency

`packages/debt-simplify/` is a **local placeholder** standing in for the
published package, which was not available when this repository was
scaffolded. It has the same module name, import path, and call signatures
(`resolveSplit`, `calculateBalances`, `simplifyDebts`, `simplifyDebtsMulti`),
so swapping it out is a dependency change and nothing more:

```bash
npm pkg set dependencies.debt-simplify="^1.0.0"
rm -rf packages/debt-simplify
npm install
npm test     # test/debt-simplify.test.ts proves the swap changed no behavior
```

If the published package's signatures differ, the only call sites to adjust
are in [`src/ledger.ts`](src/ledger.ts) — nothing else in the API knows how
the arithmetic works (FR-501).

## Layout

```
src/
  index.ts        app wiring: CORS, security headers, body limit, error envelope
  middleware.ts   auth, rate limiting, group membership and role checks
  validation.ts   every Zod schema; the single definition of what input is legal
  ledger.ts       expense reads/writes and balance derivation
  crypto.ts       password hashing, token generation, invite codes (WebCrypto only)
  schema.ts       Drizzle table definitions and indexes
  openapi.ts      OpenAPI document generated from the Zod schemas
  errors.ts       the error envelope and its code set
  routes/         auth, users, groups, expenses, settlements
migrations/       generated SQL, applied by wrangler
test/             integration tests against the real Workers runtime
packages/         the debt-simplify placeholder (see above)
```

## License

MIT
