# Tallyup — Project Brief

> Start here. This file orients an AI coding agent (or a human) to the
> whole project before touching any other doc. Read the docs in this
> order: this file → `docs/01-REQUIREMENTS.md` → `docs/02-ARCHITECTURE.md`
> → `docs/03-DATA-MODEL.md` → `docs/04-API-SPEC.md` → `docs/05-SECURITY.md`
> → `docs/06-DEPLOYMENT.md` → `docs/07-ROADMAP.md`.

## What this is

**Tallyup** is a small, open-source, production-grade REST API for tracking
shared group expenses and calculating the minimum set of payments needed
to settle everyone up. It's a reference backend: any frontend (web app,
mobile app, CLI, Slack bot) can be built against it, but the API itself —
auth, data model, business logic — is the deliverable and the portfolio
piece.

The debt-simplification math itself already exists as a separate,
published, zero-dependency library: **`debt-simplify`**
(`calculateBalances` + `simplifyDebts`). Tallyup is a real application
*built on top of* that library — it adds users, groups, persistence,
auth, and an HTTP API around the pure math. Treat `debt-simplify` as an
external npm dependency, not something to reimplement inline.

## Why it exists (portfolio framing)

Most portfolio CRUD apps stop at "looks nice in a demo." Tallyup is meant
to demonstrate the things that actually separate a junior project from a
production-minded one:

- A **published library** consumed by a **real application**, proving the
  "backend as reusable building block" story end to end.
- **Security treated as a first-class requirement**, not an afterthought
  (see `docs/05-SECURITY.md`) — auth, input validation, authorization
  checks, rate limiting, secrets handling.
- A **deliberately chosen, fully free, production-viable stack** — not
  "free because it's a toy," but free because the architecture (edge
  compute + edge database) genuinely doesn't need to cost anything at
  portfolio-level traffic. See `docs/02-ARCHITECTURE.md` for the exact
  reasoning and the numbers behind it.
- **Documentation that a hiring manager (or a teammate) could actually
  onboard from** — requirements, data model, API spec, security model,
  deployment steps, all written down before code exists.

## Non-goals (explicitly out of scope)

- **No real money movement.** Settlements are a record that "X paid Y
  back," not a payment integration. Don't add Stripe/PayPal — that pulls
  in PCI/compliance scope this project doesn't need.
- **Not a Splitwise competitor.** No ambition to acquire real users or
  monetize. It's a reference implementation.
- **No mobile app in this repo.** The API is the product; a thin demo
  frontend (see `docs/07-ROADMAP.md` Phase 3) is optional polish, not
  core scope.

## Ground rules for whoever builds this

1. **Follow the phased roadmap in `docs/07-ROADMAP.md`.** Don't build
   Phase 3 features while Phase 1 is incomplete — each phase has
   explicit acceptance criteria; treat them as Definition of Done.
2. **Every requirement in `docs/01-REQUIREMENTS.md` has an ID
   (FR-xxx / NFR-xxx).** Reference these IDs in commit messages and PR
   descriptions so it's traceable which requirement a change satisfies.
3. **Don't deviate from the stack in `docs/02-ARCHITECTURE.md` without
   updating that doc first.** The stack was chosen specifically to stay
   inside free tiers — swapping a piece (e.g. Postgres instead of D1)
   has real cost and behavior implications that need to be re-reasoned
   through, not silently substituted.
4. **Security controls in `docs/05-SECURITY.md` are requirements, not
   suggestions.** Anything marked "MUST" blocks a phase from being
   considered done.
5. **When free-tier numbers matter for a decision** (rate limit
   thresholds, CPU time budgets, storage caps), the docs here were
   verified against Cloudflare's official limits page as of the
   research date noted in `docs/02-ARCHITECTURE.md`. Free-tier terms
   change — re-verify before relying on an exact number in production
   code (e.g. a hardcoded rate-limit threshold).
