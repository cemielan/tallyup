# Roadmap

Each phase lists its acceptance criteria. Treat them as the Definition of
Done.

## Before the revamp: account-based API (retired)

Tallyup started as an account-based REST API: users, JWT auth, groups,
invite codes, server-side ledgers and settlements, plus a vanilla-JS
reference client. That version was never deployed to production.

It was removed for the PWA revamp, because "no sign-up" and "the server
cannot read your data" cannot both hold when the server computes balances.
It remains in git history before the revamp commit. The arithmetic library,
`debt-simplify`, carried over unchanged.

## R0: Docs

- [x] Brief, requirements, architecture, data model, API spec, security,
      deployment and roadmap rewritten for the encrypted-share design.

## R1: Shares API

- [x] `shares`, `share_claims` and `rate_limits` tables, with one fresh
      migration.
- [x] Seven endpoints: create, read, update (compare-and-swap), delete, and
      list / add / remove claims.
- [x] Edit token hashed at rest. Per-IP rate limits. Ciphertext and claim
      caps. 64 KiB body limit with the error envelope.
- [x] 30-day expiry honoured on read. Daily cron sweep.
- [x] ~~CORS open to any origin. OpenAPI generated from Zod.~~ Reverted in R7.
- [x] Integration tests in the Workers runtime cover every route, its
      authorization failures, conflicts, expiry and the sweep.

## R2: PWA core

- [x] Svelte 5 + Vite, served from the same Worker. Manifest, icons and
      service worker.
- [x] AES-256-GCM in the browser. Key in the fragment. Host link imported
      and stripped from the address bar.
- [x] Device-local history. Draft autosave. Persistent-storage request.
- [x] Event editor: people, bank details (optional holder), bills, items,
      assignees, tax / service / discount.
- [x] Receipt with printing animation, torn edge, PAID stamps and confetti.
      Reduced motion respected.
- [x] Native share sheet with a clipboard fallback. Host link backup.

## R3: Payments

- [x] Viewer picks who they are and sees what they owe, to whom, and the
      receiver's bank details with a copy button.
- [x] "I've paid" sends an encrypted claim. Host confirms or declines.
      Host can also mark paid or undo.
- [x] Reset share link (new key, claims cleared). Delete event.

## R4: OCR

- [x] Tesseract.js self-hosted, LSTM-only, `ind` + `eng`. Runs only when
      someone scans.
- [x] Receipt parser for Indonesian formats (`35.000`, `,00`, PB1 / PPN,
      service, diskon), with unit tests on realistic OCR text.
- [x] Mismatch warning against the printed total.
- [ ] **Field test on real receipts.** The parser is tested on synthetic
      OCR text and on a rendered receipt in a headless browser. It has not
      been tried against a pile of real, crumpled thermal receipts. Collect
      ten or more, record the hit rate, and tune `receipt-parser.ts` from
      the failures.

## R5: Public API (cancelled 2026-10-05)

An open API would share the free daily budget with outside apps, and its
abuse protection would need API keys and per-key quotas. The API now serves
only the PWA (FR-401).

## R6: Ready for public traffic

- [x] Reads spend no D1 writes. One request opens an event, with its
      claims.
- [x] Per-address write limits sized to the daily budget. IPv6 keyed by /64.
- [x] Event JSON gzipped before encryption. The largest legal event still
      fits the ciphertext cap.
- [x] Creation stops at 450 MB, below D1 Free's 500 MB cap.
- [x] Clear "busy" message when a platform limit is hit. Drafts are never
      lost.
- [ ] After launch: watch D1 rows written per day for a week, and decide on
      Workers Paid using the triggers in Architecture §3.

## R7: Abuse and privacy hardening

- [x] Public API removed: no CORS headers, no OpenAPI or `/docs`.
- [x] Turnstile client pass on create and claim. Limits count per pass,
      with a per-address backstop. Fails closed.
- [x] Blocked requests and failed checks logged by scope, without
      addresses.
- [x] Account numbers masked on the receipt, revealed on the payer's
      card. Bank details removed automatically once settled.
- [x] Shared-computer mode, and "Forget on this device".
- [x] The service worker no longer touches third-party requests. It had
      been breaking the Turnstile script load.
- [x] Database created near users (`--location=apac`).
- [ ] Edge protection on a custom domain: WAF rate-limiting rule, Bot
      Fight Mode, `workers_dev = false` (Deployment §9). Dashboard work;
      do it before a wide launch.

## Open items

| Gap | Why it matters |
|---|---|
| UI rendering has no automated tests | The views were verified by driving the real app in headless Chrome, which is not wired into CI. Only the pure logic is covered in CI. |
| Edge latency never measured | NFR-201 needs dashboard numbers after a deploy. Local numbers are not evidence. |
| `_headers` behaviour checked in `wrangler dev` only | Check the CSP header on the deployed site (Deployment §4, step 4). |
| iOS Safari not tested | Storage eviction, the share sheet and camera capture behave differently there. Test on a real iPhone, both in Safari and installed to the Home Screen. |
| Backup never run | Run Deployment §7 once, so the process is proven. |

## Later, if it earns its place

- Indonesian UI copy.
- QRIS / e-wallet payment details.
- Export the receipt as an image.
- Cross-device history, using password-wrapped keys so the server stays
  blind.
- Multi-currency events (the library already supports
  `simplifyDebtsMulti`).
