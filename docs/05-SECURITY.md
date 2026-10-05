# Security

Every `MUST` here is a requirement (NFR-102). Section numbers are cited
from the code, so keep them stable.

## 1. Threat model

| Asset | Who should see it | Protected by |
|---|---|---|
| Event contents (names, items, amounts, bank details) | Holders of the view link | End-to-end encryption (§2) |
| Edit rights | The host, through the host link | Edit token, stored hashed (§2) |
| Receipt photos | Only the device that took them | On-device OCR, no upload path (FR-201) |
| Service availability on the free tier | Everyone | Rate limits and size caps (§3, §4) |

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
- GCM authenticates. A ciphertext tampered in storage or transit fails to
  decrypt, and the app reports a broken link rather than rendering altered
  numbers.

**What a viewer can do.** A viewer holds the key, so a viewer could encrypt
a forged event. They cannot store it, because `PUT` needs the edit token.
They can forge a claim, but a claim changes nothing until the host
confirms it.

## 3. Rate limiting and abuse

- Every IP: 120 requests per minute on `/v1/shares/*`. Creates: 30 per hour.
  Claims: 20 per hour. Fixed-window counters live in D1 (Architecture §1
  explains why not KV), and a blocked request gets `429` + `Retry-After`.
- Unanswered claims MUST be capped at 50 per share.
- Shares MUST expire 30 days after the last update. Reads MUST honour
  expiry before the sweep runs.

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

## 5. CORS

`/v1/*` allows any origin. This is safe because no credential is ambient:
there are no cookies, and the edit token must be attached explicitly by
code that already holds it. A hostile page can do nothing through a
visitor's browser that it could not do with curl.

## 6. Browser hardening

Static assets carry the headers in `web/public/_headers`:

- `Content-Security-Policy`:
  - `script-src 'self' 'wasm-unsafe-eval'`. WebAssembly compilation is
    allowed for OCR; `eval` of JavaScript is not.
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

- The Worker has no secrets: no signing key, no API keys. `.dev.vars` is
  unused, and still gitignored in case one is added later.
- Dependabot runs weekly (NFR-503). CI runs `npm audit --omit=dev` and
  reports without failing.
- Third-party code at runtime: Svelte (MIT), Zod (MIT), Tesseract.js
  (Apache-2.0) with its language data (MIT), and canvas-confetti (ISC).
  Hono and Drizzle (MIT) run on the server. Google Fonts are the only
  third-party network fetch, and they reveal nothing about events.

## 8. Known limitations

- **Device-local history.** Losing browser storage loses edit access unless
  the host link was saved.
- **Bank details are visible to every link holder.** The UI says so next to
  the fields.
- **Claims are unauthenticated** by design. Spam is bounded by the per-share
  cap and the per-IP limit, and only the host's confirmation counts.
- **No forward secrecy for an event.** Anyone who once had the key can read
  every later version until the host resets the link.
