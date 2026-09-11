# Security

Requirements here marked **MUST** block phase completion (NFR-101).
This is a financial-adjacent app (it tracks who owes whom) even though
it never touches real payment rails — treat user data and integrity of
balances with the seriousness that implies.

## 1. Threat model (what this app is actually exposed to)

| Threat | Why it matters here | Primary control |
|---|---|---|
| Credential stuffing / brute force login | Standard for any password auth | Rate limiting on `/auth/login` (§4), generic error message (§2) |
| Broken authorization (IDOR) | The app's core data — groups, expenses, balances — is exactly what a missing membership check would leak or corrupt | Membership check before every group-scoped read/write (NFR-102) |
| JWT theft/replay | Access tokens are bearer credentials | Short expiry (15 min), refresh rotation, HTTPS-only |
| Refresh token theft | Longer-lived than access tokens, higher value if stolen | Stored hashed, rotated on every use, revocable |
| Invite code brute-forcing | An invite code is effectively a password for joining a group | High-entropy codes, rate-limited join attempts |
| Injection (SQL) | Any app touching a database | Parameterized queries only, via Drizzle — no raw string-concatenated SQL, ever |
| Mass assignment / over-posting | Expense/group updates take user input | Zod schemas define exactly which fields are accepted; unknown fields rejected, not silently ignored |
| Resource exhaustion on a metered free tier | Unlike a paid server, hitting a free-tier limit here means **downtime**, not a bill — a denial-of-wallet attack becomes a denial-of-service attack | Rate limiting (§4), request size limits, sane pagination caps (NFR-203) |
| Dependency vulnerabilities | Any npm-based project | Dependabot/`npm audit` in CI (NFR-503) |
| Secret leakage | Any project with signing keys | Wrangler secrets only, `.dev.vars` gitignored, no secrets in logs |

## 2. Authentication

- **MUST** hash passwords before storage. Use a WebCrypto-native
  algorithm since Workers can't run native (non-WASM) Node addons like
  the common `argon2` package. Concretely: **PBKDF2-SHA256 via
  `crypto.subtle.deriveBits`**, with a per-user random salt (16 bytes)
  and an iteration count tuned to land safely under the platform's 10ms
  CPU-per-request budget (§Architecture) — benchmark this specific
  number at implementation time rather than guessing; don't ship a
  count that risks Error 1102 on login. If a WASM-compiled Argon2id
  build for Workers proves fast and reliable at implementation time, it
  is an acceptable stronger alternative — document the choice and the
  benchmark either way.
- **MUST** return the identical error (`INVALID_CREDENTIALS`, generic
  message) whether the email doesn't exist or the password is wrong —
  no user enumeration via differing error messages or response timing.
  Use a constant-time comparison for the password check itself.
- **MUST** issue access tokens as JWTs signed with `HS256`, secret ≥256
  bits, stored via `wrangler secret`, expiry **15 minutes**.
- **MUST** issue refresh tokens as high-entropy random strings (not
  JWTs — no need for them to be self-describing), expiry 30 days,
  **stored server-side only as a hash** (SHA-256 is fine here — this is
  an opaque token comparison, not a password needing slow hashing).
- **MUST** rotate the refresh token on every use (`POST /auth/refresh`
  issues a new refresh token and invalidates the old one). If an
  already-used/revoked refresh token is presented again, treat it as a
  signal of possible theft and revoke the entire token family for that
  user, not just the one token.
- **MUST NOT** log raw passwords, raw tokens, or raw password hashes at
  any log level, including on error paths.

## 3. Authorization

- **MUST** check group membership before any group-scoped read or write
  — implement this as shared middleware applied to every group/expense
  route, not as a copy-pasted check per handler (a missed copy-paste is
  exactly how IDOR bugs happen).
- **MUST** check role (`owner` vs `member`) for owner-only actions
  (remove member, rotate invite code) server-side — never trust a role
  claim from the client.
- **MUST** verify expense participants are actual group members
  (FR-303) at write time, not just at read time.
- **MUST** return `404 NOT_FOUND` (not `403 FORBIDDEN`) when a caller
  who isn't a group member requests that group's resources, so a
  non-member can't distinguish "doesn't exist" from "exists but you're
  not in it."

## 4. Rate limiting

Given the free-tier KV write budget (1,000/day — see Architecture §3),
the rate limiter **MUST NOT** write to KV on every single request.
Design pattern: track a counter in KV per (IP or user, endpoint-class,
time-window) and only write when the window rolls over or the count
changes meaningfully — read-heavy, write-light. Exact algorithm is an
implementation detail, but the write-budget constraint is not optional.

Minimum required limits:

| Endpoint class | Limit | Key |
|---|---|---|
| `/auth/login`, `/auth/register` | 5 requests / 5 minutes | per IP |
| `/groups/join` | 10 requests / hour | per IP (invite code brute-force protection) |
| All other authenticated endpoints | 100 requests / minute | per user |

Exceeding a limit **MUST** return `429 RATE_LIMITED` with a `Retry-After`
header, using the `RATE_LIMITED` error code from the API spec.

## 5. Input validation

- **MUST** validate every request body, query param, and path param with
  a Zod schema before it reaches business logic — reject unknown fields
  (`.strict()`), don't silently drop them.
- **MUST** validate monetary amounts are positive integers within a
  sane upper bound (e.g. reject an expense claiming a $10 billion
  hotel bill — pick a real ceiling and document it in the schema).
- **MUST** validate `exact` and `percentage` splits sum correctly at the
  API layer *before* calling into `debt-simplify`, so validation errors
  come back as a clean `422` with a useful message rather than the
  library throwing.

## 6. Transport & headers

- **MUST** be served over HTTPS only (Cloudflare provides this by
  default for Workers — don't disable it).
- **MUST** set a strict CORS policy: an explicit allow-list of origins
  (configured per environment), never `Access-Control-Allow-Origin: *`
  for authenticated routes.
- **SHOULD** set standard security headers (`X-Content-Type-Options:
  nosniff`, `Referrer-Policy: no-referrer`) — low effort, standard
  hygiene, even though this is a pure JSON API with no HTML surface to
  protect from XSS directly.

## 7. Secrets & configuration

- **MUST** keep all secrets (JWT signing key, any future third-party API
  keys) out of `wrangler.toml` and out of git entirely. Local dev uses
  `.dev.vars` (gitignored); production uses `wrangler secret put`.
  Commit a `.dev.vars.example` with placeholder values so setup is
  discoverable (serves NFR-303, the 10-minute-clone-to-running goal).
- **MUST** use a different JWT signing secret per environment
  (local/staging/production) so a leaked local secret can't be used
  against production.

## 8. Auditability

- **SHOULD** log (server-side only, never returned to the client)
  security-relevant events: failed logins, refresh token reuse
  detection, role-gated actions (member removal, invite rotation).
  This is a `SHOULD` for the MVP and becomes a `MUST` if the project
  ever handles more than portfolio-level trust.

## 9. Explicitly out of scope (and why that's fine)

- **No PCI scope.** Tallyup never stores or processes card numbers, bank
  details, or moves real money — settlements are a confirmation record,
  not a payment (see Project Brief non-goals). This is a deliberate
  scope boundary, not an oversight.
- **No GDPR-grade data portability/erasure tooling in the MVP.** For a
  portfolio project with no real user base this is a reasonable initial
  gap — but if you ever host this beyond your own testing, revisit this
  section before doing so.
