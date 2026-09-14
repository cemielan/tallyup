# Roadmap

Build in this order. Each phase lists its acceptance criteria — treat
these as Definition of Done, not suggestions. Don't start a phase until
the previous one's criteria are all met (Project Brief, Ground Rule 1).

## Phase 0 — Foundation library (already done)

`debt-simplify` exists, is published (or ready to publish) as its own
npm package, has passing tests, and is not to be modified as part of
this project except through its own repo/release process (FR-501/502).

**Acceptance:** `npm install debt-simplify` works from the published
package (or a local `file:` reference during development), and Tallyup
never contains a local reimplementation of `calculateBalances` or
`simplifyDebts`.

## Phase 1 — MVP: auth, groups, equal-split expenses, read-only settlement

Scope: FR-101 through FR-108, FR-201 through FR-206, FR-301 (equal split
only — defer exact/percentage/shares to Phase 2), FR-304, FR-305,
FR-401, FR-402, FR-501.

Security: every `MUST` in `docs/05-SECURITY.md` §2 (auth), §3
(authorization), §5 (input validation) — rate limiting (§4) can be a
simple fixed-window placeholder in Phase 1 and hardened in Phase 2.

**Acceptance criteria:**
- [ ] A user can register, log in, and refresh their session.
- [ ] A user can create a group and invite others via code.
- [ ] A user can add an equal-split expense and see it in the group's
      expense list.
- [ ] `GET /balances` and `GET /settlements/suggested` return correct
      results for a multi-person, multi-expense scenario (write this as
      an actual integration test with a scripted scenario, not just
      manual curl checks).
- [ ] Every group/expense route rejects a non-member with `404`
      (NFR-102 — write a test specifically for this, per group).
- [ ] Deployed to Cloudflare Workers, reachable over HTTPS, `$0` cost so
      far.
- [ ] CI runs lint + typecheck + tests on every PR (NFR-404).

## Phase 2 — Full splits, settlement confirmation, hardened security

Scope: FR-302 (exact/percentage/shares), FR-306 through FR-309, FR-403
through FR-405, FR-207.

Security: the production-grade rate limiter design from §4 (KV
write-budget-aware, not fixed-window-per-request), refresh token
rotation-with-reuse-detection (§2), CORS allow-list finalized for
whatever frontend(s) will actually call this.

**Acceptance criteria:**
- [ ] All four split types work and have integration tests, including
      a test that an incorrectly-summed `exact`/`percentage` split
      returns a clean `422`, not a 500.
- [ ] Editing or deleting an expense correctly changes subsequent
      balance calculations (test this explicitly — it's the kind of bug
      that's invisible until someone edits something).
- [ ] A settlement can be proposed, confirmed by the receiving party,
      and correctly zeroes out (or reduces) the relevant balance.
- [ ] A settlement can be declined without affecting balances.
- [ ] Rate limits are enforced and return `429` with `Retry-After`; KV
      write count under real test traffic is checked against the
      1,000/day budget (Architecture §3) and confirmed sustainable.
- [ ] OpenAPI spec (NFR-301) is generated and served, and matches the
      API Spec doc — if they've drifted, fix the doc, not just the code.
- [ ] Test coverage for the service/domain layer is above 80% (NFR-501).

## Phase 3 — Polish, multi-currency, demo consumer

Scope: FR-405 (multi-currency, if not already done in Phase 2 — pull it
forward if straightforward), remaining `SHOULD`/`MAY` items worth doing.

**Acceptance criteria:**
- [ ] Multi-currency groups keep balances/settlements separate per
      currency, verified with a test group holding both USD and IDR
      expenses.
- [ ] README has the full working `curl` flow (NFR-304) and a clear
      "why this exists / what it demonstrates" section for anyone
      landing on the repo cold (recruiters, in particular).
- [x] A reference consumer exists, proving the "different frontends, same
      backend" story from the Project Brief. **Delivered beyond this
      criterion, deliberately:** the acceptance bar here was a throwaway
      HTML+fetch page, and what was built is a designed, responsive,
      accessible client covering every endpoint (`web/`). That was an
      explicit request, not scope creep that happened by accident — but it
      is recorded here so the gap between "what the roadmap asked for" and
      "what exists" is visible rather than quietly assumed.

      It is also worth being honest about the ordering: this was built
      before Phase 2's remaining acceptance criteria (service-layer
      coverage above 80%, and the CPU benchmark behind NFR-202 and
      Security §2) were met, which contradicts Ground Rule 1 in the
      Project Brief. Those two items remain the real outstanding work.
- [ ] Dependabot (or equivalent) is enabled and green (NFR-503).
- [ ] A backup export has actually been run once, following
      `docs/06-DEPLOYMENT.md` §7, so the process is proven, not just
      documented.

## Known gaps, carried forward

These are open and deliberately recorded rather than discovered later:

| Gap | Requirement | Why it matters |
|---|---|---|
| PBKDF2 iteration count is unbenchmarked | NFR-202, Security §2 | The count ships at 100,000. Security §2 requires benchmarking it against the per-request CPU budget before relying on it; too high risks Error 1102 on every login, too low weakens the hash. This is the single highest-risk unverified assumption in the project. |
| No test-coverage measurement | NFR-501 | The 80% service-layer floor is unmeasured, so it is unproven rather than met. |
| No load test of the balances path | NFR-201 | The p95-under-200ms claim has not been measured at the edge. |
| Web client has no automated test | — | The client was verified once by driving it in a real browser engine, but nothing in CI would catch a regression in it. |

## Explicitly deferred (not on this roadmap)

- Password reset via email (FR-109) — needs an email-sending free tier
  decision not yet made; revisit only if this project outgrows
  portfolio status.
- Real payment integration — out of scope permanently (Project Brief
  non-goals).
- Mobile app / polished frontend — out of scope for this repo
  permanently; Phase 3's demo consumer is intentionally minimal.
