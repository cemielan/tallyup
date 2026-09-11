# Requirements

Every requirement has a stable ID so it can be referenced from commits,
PRs, and tests. `MUST` = blocks release of the phase it belongs to.
`SHOULD` = strongly desired, can slip to the next phase with a documented
reason. `MAY` = optional / nice-to-have.

## 1. Functional Requirements

### 1.1 Authentication & Account

| ID | Requirement | Priority |
|---|---|---|
| FR-101 | A visitor MUST be able to register with an email and password. | MUST |
| FR-102 | Passwords MUST be validated for minimum strength (length ≥ 10, not in a common-password blocklist) before hashing. | MUST |
| FR-103 | A registered user MUST be able to log in and receive a short-lived access token and a longer-lived refresh token. | MUST |
| FR-104 | A user MUST be able to refresh an expired access token using a valid, unexpired refresh token. | MUST |
| FR-105 | A user MUST be able to log out, which revokes the refresh token used. | MUST |
| FR-106 | A user MUST be able to log out of all sessions (revoke all their refresh tokens at once). | SHOULD |
| FR-107 | A user MUST be able to fetch their own profile (`GET /v1/users/me`). | MUST |
| FR-108 | A user SHOULD be able to update their display name. | SHOULD |
| FR-109 | Password reset via emailed link MAY be added once an email-sending free tier is wired up (see Architecture). Out of scope for MVP — documented as a known gap, not silently missing. | MAY |

### 1.2 Groups

| ID | Requirement | Priority |
|---|---|---|
| FR-201 | A logged-in user MUST be able to create a group with a name. Creating a group makes the creator a member with an `owner` role. | MUST |
| FR-202 | A group MUST support an invite mechanism: a shareable, unguessable invite code that adds the joining user as a `member`. | MUST |
| FR-203 | A member MUST be able to list all groups they belong to. | MUST |
| FR-204 | A member MUST be able to view a single group's details, including its member list. | MUST |
| FR-205 | An `owner` MUST be able to remove a member from a group, provided that member has a zero balance (no outstanding debts either direction) at the time of removal. | MUST |
| FR-206 | A member MUST be able to leave a group voluntarily, subject to the same zero-balance rule as FR-205. | MUST |
| FR-207 | An `owner` SHOULD be able to rotate/regenerate the invite code (invalidating the old one) if it leaks. | SHOULD |

### 1.3 Expenses

| ID | Requirement | Priority |
|---|---|---|
| FR-301 | A group member MUST be able to record an expense: amount, currency, who paid, a description, and a split. | MUST |
| FR-302 | The API MUST support all four split types from the `debt-simplify` library: `equal`, `exact`, `percentage`, `shares`. | MUST |
| FR-303 | Only group members MAY be named as payer or participant in an expense within that group. | MUST |
| FR-304 | A member MUST be able to list a group's expenses, paginated, newest first. | MUST |
| FR-305 | A member MUST be able to view a single expense's full detail (who paid, full split breakdown). | MUST |
| FR-306 | The expense creator or the group `owner` MUST be able to edit an expense (amount, description, split). | MUST |
| FR-307 | The expense creator or the group `owner` MUST be able to delete an expense. | MUST |
| FR-308 | Editing or deleting an expense MUST recompute the group's balances — balances are always derived, never independently mutated. | MUST |
| FR-309 | The API SHOULD support attaching a category/tag to an expense for filtering. | MAY |

### 1.4 Balances & Settlements

| ID | Requirement | Priority |
|---|---|---|
| FR-401 | A member MUST be able to fetch a group's current net balances per person, computed via `calculateBalances`. | MUST |
| FR-402 | A member MUST be able to fetch the group's simplified settlement plan (minimum transactions to zero everyone out), computed via `simplifyDebts`. | MUST |
| FR-403 | A member MUST be able to mark a suggested settlement as paid, which records a settlement-confirmation expense so balances update accordingly. | MUST |
| FR-404 | Settlement confirmation MUST require confirmation from the receiving party (the person being marked as "paid") before it's finalized — a payer can't unilaterally mark a debt settled. | SHOULD (MUST by Phase 2) |
| FR-405 | Multi-currency groups MUST keep balances and settlements separate per currency (via `simplifyDebtsMulti`), never netted across currencies. | MUST |

### 1.5 Library Boundary

| ID | Requirement | Priority |
|---|---|---|
| FR-501 | All debt-simplification math MUST go through the published `debt-simplify` package — the API layer MUST NOT reimplement or fork that logic. | MUST |
| FR-502 | If a bug or missing feature is found in `debt-simplify` while building Tallyup, it MUST be fixed in the library repo and released as a new version, then bumped in Tallyup — not patched around locally. | MUST |

## 2. Non-Functional Requirements

### 2.1 Security

| ID | Requirement | Priority |
|---|---|---|
| NFR-101 | All requirements in `docs/05-SECURITY.md` marked MUST are non-negotiable and block phase completion. | MUST |
| NFR-102 | No endpoint that reads or writes group/expense data may skip an authorization check that the caller is a member of that group. | MUST |
| NFR-103 | No secret (JWT signing key, API tokens) may be committed to the repository at any point in its history. | MUST |

### 2.2 Performance

| ID | Requirement | Priority |
|---|---|---|
| NFR-201 | p95 response time for read endpoints (balances, list expenses, get group) MUST be under 200ms measured at the edge, excluding client network latency. | MUST |
| NFR-202 | The `simplifyDebts` computation MUST complete within the platform's per-request CPU time budget for groups up to 50 members (see Architecture for the exact budget and why this cap exists). | MUST |
| NFR-203 | List endpoints MUST be paginated (default page size 20, max 100) — no unbounded result sets. | MUST |
| NFR-204 | Database queries MUST use indexes for every foreign-key lookup and every filter used in a list endpoint (see Data Model for the index list). | MUST |

### 2.3 Usability / Developer Experience

| ID | Requirement | Priority |
|---|---|---|
| NFR-301 | The API MUST publish an OpenAPI 3.x spec, kept in sync with the actual route definitions (generated from the same Zod schemas used for validation, not hand-maintained separately). | MUST |
| NFR-302 | Every error response MUST use one consistent JSON envelope (see API Spec §"Error format") — no endpoint returns a bare string or an ad hoc shape. | MUST |
| NFR-303 | A new developer MUST be able to go from `git clone` to a running local instance in under 10 minutes following `docs/06-DEPLOYMENT.md`. | MUST |
| NFR-304 | The README MUST include a working `curl` example for at least one full flow (register → create group → add expense → get settlement). | MUST |

### 2.4 Reliability & Cost

| ID | Requirement | Priority |
|---|---|---|
| NFR-401 | The deployed system MUST cost $0/month at the traffic levels defined in Architecture's "free-tier budget" table. | MUST |
| NFR-402 | If projected usage would exceed a free-tier limit, this MUST be documented in `docs/02-ARCHITECTURE.md` §"Upgrade triggers" with the specific limit and the cheapest mitigation — not discovered by an outage. | MUST |
| NFR-403 | The system SHOULD have zero cold-start latency for the API layer (a direct consequence of the platform choice in Architecture, not something to re-derive). | SHOULD |
| NFR-404 | CI MUST run lint, typecheck, and the full test suite on every pull request before merge is allowed. | MUST |

### 2.5 Maintainability

| ID | Requirement | Priority |
|---|---|---|
| NFR-501 | Test coverage for business logic (everything under the service/domain layer, excluding thin HTTP handlers) MUST stay above 80%. | MUST |
| NFR-502 | Every public API route MUST have at least one integration test covering the happy path and one covering an authorization failure. | MUST |
| NFR-503 | Dependency vulnerability scanning (GitHub Dependabot or equivalent, free for public repos) MUST be enabled. | MUST |
