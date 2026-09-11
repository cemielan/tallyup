# Architecture

## 1. Chosen stack

| Layer | Choice | Why |
|---|---|---|
| Compute | **Cloudflare Workers** | Free plan runs forever, no card required, and — unlike Render/Railway/Fly free tiers — **does not spin down when idle**. For a portfolio project a recruiter might click at any time, "always warm, zero cold start" matters more than raw throughput. |
| Web framework | **Hono** | Tiny, fast, first-class Workers support, Express-like routing so it's easy to pick up, built-in middleware for CORS/JWT. |
| Language | **TypeScript** | Matches the `debt-simplify` library; type-safety end to end. |
| Database | **Cloudflare D1** (SQLite at the edge) | Binds directly to the Worker with no network hop (unlike calling an external Postgres over the internet from an edge function), which is both faster and keeps the whole stack inside one free account. Trade-off: SQLite, not Postgres — see §4. |
| ORM | **Drizzle ORM** | First-class D1 support, generates real SQL you can read, lightweight, good TypeScript inference. (Prisma's D1 support is newer/less mature — Drizzle is the safer choice for this stack today.) |
| Validation | **Zod** | Request/response schemas double as the source for the OpenAPI spec (NFR-301) — one definition, not two to keep in sync. |
| Auth | Custom JWT (access + refresh) using the Workers-native `crypto.subtle` (WebCrypto) API | No native Node dependencies (which don't run in the Workers isolate). See Security doc for exact algorithm choices. |
| Testing | **Vitest** + `@cloudflare/vitest-pool-workers` | Runs tests inside the actual Workers runtime (via Miniflare), not a Node approximation — catches Workers-specific bugs (e.g. missing Node APIs) that a plain Node test runner would miss. |
| CI/CD | **GitHub Actions** + `wrangler deploy` | Free for public repos; deploy step uses Cloudflare's official `wrangler-action`. |
| API docs | **Scalar** (or Swagger UI) serving the generated OpenAPI JSON | Free, static, no separate hosting needed — served by the same Worker. |
| Rate limiting | **D1**-backed fixed-window counter (one upsert per request) | Originally specified as KV. Changed during implementation because the free KV write budget is 1,000/day (§3), which a per-request counter exhausts within an hour of modest traffic, while D1's free write allowance is two orders of magnitude larger and needs no extra binding. This is the mitigation this document already named under "Upgrade triggers", adopted up front rather than after an outage. |
| Secrets | `wrangler secret put` (production) + `.dev.vars` (local, gitignored) | Never in source control, never in `wrangler.toml`. |
| Domain | `*.workers.dev` free subdomain by default; a custom domain is free to attach if you already own one (Cloudflare doesn't charge for the attachment, only domain registration itself costs money elsewhere). | |

## 2. High-level flow

```
Client (web/mobile/CLI/Slack bot — any of these, none of them included in this repo)
        │  HTTPS, JSON, Bearer JWT
        ▼
Cloudflare Worker (Hono router)
   ├─ auth middleware (verifies JWT, loads user)
   ├─ rate-limit middleware (KV sliding window)
   ├─ route handler (validates body with Zod)
   ├─ authorization check (is caller a member of this group?)
   ├─ service layer (business logic, calls into debt-simplify)
   └─ Drizzle ORM
        ▼
Cloudflare D1 (SQLite, bound directly — no network hop)
```

The `debt-simplify` package is imported as a normal npm dependency inside
the service layer. It never touches HTTP, auth, or the database — it's
pure functions in, data out (per its own design notes).

## 3. Free-tier budget

These numbers come from Cloudflare's official Workers limits documentation
(free plan, verified against `developers.cloudflare.com/workers/platform/limits`
during research for this doc). **Re-verify before hard-coding any of these
as a production assumption — free-tier terms are Cloudflare's to change.**

| Resource | Free limit | What that means for Tallyup |
|---|---|---|
| Requests | 100,000/day (~3M/month), reset 00:00 UTC | Roughly 1 request/second sustained, all day, every day. For a portfolio demo hit by recruiters and your own testing, this is enormous headroom. |
| CPU time per request | **10ms** | This is the tightest real constraint in the whole stack. Most Workers use ~1-2ms; heavier auth/parsing work typically lands 10-20ms — meaning a naive implementation can blow the free budget. Concretely: **password hashing and the `simplifyDebts` loop are the two places to watch.** Use a WebCrypto-native, moderate-cost hashing approach (see Security doc) and keep the settlement algorithm's group-size assumption realistic (§ NFR-202 caps it at 50 members — an O(n log n) sort well within budget at that size). Load-test this specific path before shipping. |
| Memory | 128MB per isolate | Not a practical constraint for this workload. |
| Subrequests | 50 per request | Watch this if a single request needs several D1 queries — batch queries where possible instead of looping individual `SELECT`s. |
| Burst rate | 1,000 requests/minute | Relevant to the rate-limiter design — the platform itself will hard-stop above this regardless of your own limits. |
| KV reads | 100,000/day | Not used — rate-limit counters live in D1 instead (see §1). |
| KV writes | **1,000/day** | This is the number that ruled KV out for rate limiting: a naive "write a KV entry per request" limiter blows it at only ~40 requests/hour sustained. Rather than approximate around it, the counters went to D1, whose free write allowance is far larger. No KV namespace is bound at all, which also removes a setup step. |
| D1 storage | ~5GB | Effectively unlimited for this app's data shape (users/groups/expenses are tiny rows). |
| Worker script size | 3MB compressed | Watch dependency bloat; this is generous for a Hono + Drizzle + Zod stack but don't casually add heavy libraries. |

### Upgrade triggers

Document any future decision to exceed free tier here, with the trigger
and the cheapest fix, so it's a deliberate choice rather than a surprise
bill:

| If this happens | Cheapest mitigation |
|---|---|
| Sustained traffic near 100k requests/day | Workers Paid is $5/month flat, includes 10M requests — a 100x headroom jump for $5. Not urgent; only relevant if this stops being a portfolio project and gets real usage. |
| D1 write budget becomes a bottleneck for rate-limit counters | Move to Durable Objects, which gives a per-key counter with no database round trip (requires Workers Paid, $5/month). The counters already batch into one upsert per request, so there is no cheaper software fix left. |
| A group exceeds 50 members and `simplifyDebts` risks the 10ms CPU budget | Cap group size at the API layer (return a clear validation error) rather than let a request silently fail with Error 1102. |

## 4. Trade-offs and known limitations

- **SQLite (D1), not Postgres.** No advanced Postgres features (window
  functions are limited, no native `JSONB`, no `LISTEN/NOTIFY`). For this
  app's schema (users, groups, expenses, splits) this is not a real
  limitation — but if the roadmap later needs something Postgres-specific,
  that's a deliberate stack change to re-document here, not a silent
  workaround.
- **No long-lived connections.** Workers are request/response only — no
  WebSocket-based live balance updates without adding Durable Objects
  (paid tier). Out of scope; poll instead.
- **The runtime compatibility date is pinned to the test runner, not to
  today.** `wrangler.toml` sets `compatibility_date` to the newest date the
  `workerd` bundled with `@cloudflare/vitest-pool-workers` accepts, so the
  suite and production agree on runtime behavior. Deploying with a newer date
  than the test runner supports would mean testing against different
  semantics than you ship; raise it only when the Vitest pool catches up.
- **10ms CPU budget is real and easy to blow without noticing locally**
  (your laptop doesn't enforce it — Miniflare/Vitest approximates it but
  production is the real test). Treat any endpoint doing hashing, JSON
  parsing of large payloads, or non-trivial computation as something to
  specifically CPU-profile before considering a phase done.

## 5. Alternative stack (documented, not chosen)

If a future need genuinely requires Postgres (e.g. complex reporting
queries), the fallback free stack is: **Neon** (permanent free Postgres
tier, ~0.5GB/project) or **Supabase** (permanent free tier, 500MB,
bundled auth) + a traditional Node/Fastify API on **Render's free web
service tier**. The explicit cost of that swap: Render's free tier
spins down after inactivity, reintroducing cold starts — which is exactly
what the chosen stack avoids. Don't make this switch without updating
NFR-403 and re-testing the cold-start assumption recruiters will
experience.
