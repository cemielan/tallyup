# Security

Every `MUST` here is a requirement (NFR-102). Section numbers are cited
from the code, so keep them stable.

## 1. Threat model

| Asset | Who should see it | Protected by |
|---|---|---|
| Event contents (names, items, amounts, bank details) | Holders of the view link | End-to-end encryption (§2) |
| Edit rights | The host, through the host link | Edit token, stored hashed (§2) |
| Receipt photos | Only the device that took them | On-device OCR, no upload path (FR-201) |
| Bank details | People who still owe the account holder | Masked on the receipt, deleted once everyone has paid (§2) |
| Service availability on the free tier | Everyone | Edge rules, Turnstile client passes, rate limits, size caps (§3, §4) |

**Out of scope for protection:** someone the link was forwarded to. The
link *is* the access. Its mitigation is "Reset share link" (FR-107), not
a control the server could enforce.

**Who is assumed hostile:** the network, any third-party website, anyone
who reads the server's database or logs, and any person who guesses or
scrapes share ids.

## 2. Encryption and credentials

- The browser MUST encrypt every event and claim with AES-256-GCM via
  WebCrypto, under a fresh 256-bit key per event (`web/src/lib/crypto.ts`).
- Every encryption MUST use a fresh random 96-bit IV. GCM is broken by IV
  reuse, so the IV is never derived or counted.
- Keys and edit tokens MUST travel only in the URL fragment. Browsers do not
  send fragments in requests or in `Referer`, and `Referrer-Policy:
  no-referrer` is set anyway (§6).
- Opening a host link MUST move its edit token into local storage and
  replace the URL with `#/h/<id>`. This keeps the token out of the
  address bar and out of screenshots.
- The edit token is 256 random bits. The server MUST store only its
  SHA-256, and MUST return the token once, on creation. A fast hash is
  correct here: the input is a random 256-bit value, not a guessable
  password.
- Share ids are 128 random bits. Even an id that leaked from a log would
  reveal nothing without the key.
- **Bank details MUST be minimised:**
  - The receipt, which is what gets screenshotted and forwarded, MUST show
    only the last four digits.
  - The full number appears only on the payer's own "You pay …" card,
    behind a tap.
  - Once nobody owes anything, the host's next save MUST remove all bank
    details from the event (`withoutBankDetailsIfSettled`).
- **Shared computers:**
  - The host MUST be able to publish without the event being remembered in
    the browser (no history entry, no draft). The host link is shown open,
    with a warning to copy it.
  - Hosts and guests MUST be able to "Forget on this device" at any time.
- GCM authenticates. A ciphertext tampered in storage or transit fails to
  decrypt, and the app reports a broken link rather than rendering altered
  numbers.

**What a viewer can do.** A viewer holds the key, so a viewer could encrypt
a forged event. They cannot store it, because `PUT` needs the edit token.
They can forge a claim, but a claim changes nothing until the host
confirms it.

## 3. Abuse and availability

Protection comes in three layers, outermost first.

**1. The edge (Deployment §9).** These run before the Worker, so requests
they block don't use up the daily request budget. This is the only layer
that stops a read flood from a single machine.

- A Cloudflare WAF rate-limiting rule on `/v1/*`, counted per IP.
- Bot Fight Mode.
- `workers_dev = false`, so the `*.workers.dev` address can't be used to
  bypass the domain's rules.

These need a custom domain.

**2. Client passes (Turnstile).** Creating an event and sending a claim
are the anonymous writes. They MUST carry a valid client pass:

- A pass is issued by `POST /v1/pass` after Cloudflare Turnstile verifies
  the browser. Most people never see a challenge.
- A pass lasts 24 hours.
- It is HMAC-signed with `PASS_SECRET` and checked statelessly, so it
  costs no database write.
- Issuing one fails closed: if Turnstile's siteverify cannot be reached,
  there is no pass.

**3. Rate limits** in fixed hourly windows held in D1:

| | Per pass | Per address (backstop) |
|---|---|---|
| Passes issued | — | 300 |
| Creates | 30 | 120 |
| Claims | 20 | 120 |
| Updates and deletes | — | 120 |

- Counting per pass means a campus network or a mobile carrier sharing one
  IPv4 address doesn't make strangers share one limit.
- The per-address backstop stops one machine from minting passes to
  multiply its quota.
- IPv6 addresses MUST be keyed by their /64 prefix, because one host
  commonly owns a whole /64. IPv4-mapped addresses are treated as IPv4.
- Reads are not rate limited in the app: each check would cost a D1 write,
  and a refused request still counts against the request budget.
- A blocked request gets `429` + `Retry-After`. The Worker logs
  `rate_limited` with the scope, never the address (Deployment §8).

Also:

- Unanswered claims MUST be capped at 50 per share.
- Creation MUST stop near the database size cap (`DB_SOFT_LIMIT_MB`), so a
  full database can never break existing events.
- Shares MUST expire 30 days after the last update. Reads MUST honour
  expiry before the sweep runs.

**What remains:** an attacker who pays a CAPTCHA-solving service, across
many addresses, can still use up a free daily budget. The damage stays
capped: there is no bill, and service resumes at 00:00 UTC. Past that
point, the answer is Workers Paid with usage alerts (Architecture §3).

## 4. Input validation

- Every body and path parameter MUST pass a Zod schema before a handler
  runs. Unknown fields are rejected (`z.strictObject`), so a client cannot
  smuggle plaintext into a column.
- Bodies over 64 KiB MUST be refused before parsing. Ciphertext is capped
  at 48,000 characters for a share and 2,000 for a claim.
- The server can check only shape. **The browser MUST validate every
  decrypted document** with the schema in `web/src/lib/doc.ts` (limits,
  digits-only account numbers, references to real people) and treat
  failure as a broken link.
- The UI renders all user text through Svelte's escaping. No `{@html}`
  is used anywhere.

## 5. Same-origin only

The API serves only the PWA on the same origin (FR-401), and sends **no
CORS headers**. A page on another site can still send a request, but the
browser won't let it read the response or send the preflighted `PUT` and
`DELETE`. There is no published API contract and no OpenAPI document.

This is not access control: curl ignores CORS. The Turnstile pass (§3) and
the edit token (§2) are what actually guard writes.

## 6. Browser hardening

Static assets carry the headers in `web/public/_headers`:

- `Content-Security-Policy`:
  - `script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com`.
    WebAssembly compilation is allowed for OCR; `eval` of JavaScript is
    not. The Turnstile origin is allowed for its script.
  - `frame-src https://challenges.cloudflare.com`, for Turnstile's widget.
  - `worker-src 'self'`. Tesseract is told not to use blob: workers, and
    canvas-confetti runs without its worker.
  - `connect-src 'self'` plus Google Fonts.
  - `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`.
- `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and
  a `Permissions-Policy` that allows only the camera, for receipt photos.

API responses get Hono's `secureHeaders`.

Check after every deploy:

```bash
curl -sI https://<host>/ | grep -i content-security
```

## 7. Secrets and dependencies

- The Worker has two secrets, `TURNSTILE_SECRET` and `PASS_SECRET`.
  Neither can decrypt anything. Leaking them would let someone mint passes
  (an abuse risk, not a privacy one). Rotating `PASS_SECRET` silently
  invalidates every pass.
  - Production: `wrangler secret put`.
  - Local: `.dev.vars`, gitignored, using Cloudflare's always-pass test
    secret.
- The service worker never caches third-party responses other than fonts.
  A stale copy of a security script would be a bug.
- Dependabot runs weekly (NFR-503). CI runs `npm audit --omit=dev` and
  reports without failing.
- Third-party code at runtime: Svelte (MIT), Zod (MIT), Tesseract.js
  (Apache-2.0) with its language data (MIT), and canvas-confetti (ISC).
  Hono and Drizzle (MIT) run on the server.
- Third-party network fetches: Google Fonts, and Cloudflare Turnstile when
  creating or claiming. Neither sees any event data.

## 8. Known limitations

- **Device-local history.** Losing browser storage loses edit access unless
  the host link was saved.
- **Bank details are visible to every link holder until everyone has
  paid.** They are masked on the receipt, but anyone with the link can
  still open a payer card. Separate links per person would fix this, at
  the cost of the "send one link" experience; it was rejected.
- **Claims are honour-system.** Anyone with the link and a pass can claim
  to be anyone. Spam is bounded by the per-share cap and the rate limits,
  and only the host's confirmation counts.
- **No forward secrecy for an event.** Anyone who once had the key can read
  every later version until the host resets the link.
