# API specification

**Internal.** This API exists to serve the Tallyup PWA on the same origin,
and it is not a public contract (FR-401). It sends no CORS headers, so
browsers block other sites from reading its responses. There is no
published OpenAPI document. This page is for people working on Tallyup.

Base URL: `https://<host>/v1`. JSON in, JSON out. Credentials:

- **Client pass** (`X-Tallyup-Pass`): proves a browser passed the
  Turnstile check. Required to create a share or a claim.
- **Edit token** (`Authorization: Bearer`): proves you are the host.
  Required to update or delete.

## 1. Encryption scheme

The server stores what it receives and never decrypts it. The PWA's
`web/src/lib/crypto.ts` implements this:

| Part | Specification |
|---|---|
| Key | 32 random bytes from a CSPRNG. Text form: base64url, no padding (43 chars). |
| Cipher | AES-256-GCM, 128-bit tag (the WebCrypto default). No additional authenticated data. |
| IV | 12 random bytes, **fresh for every encryption**. Never reuse one under the same key. Text form: base64url, no padding (16 chars). |
| Plaintext | UTF-8 JSON of the event document (`docs/03-DATA-MODEL.md` §2) or a claim document, **optionally gzip-compressed** (RFC 1952). Writers SHOULD compress; readers MUST accept both. A gzip stream starts `1f 8b`, which JSON never does. |
| Ciphertext | The cipher output with the tag appended, as WebCrypto returns it. Text form: base64url, no padding. |
| View link | `https://<host>/#/s/<shareId>/<key>` |
| Host link | `https://<host>/#/e/<shareId>/<key>/<editToken>` |

Keys and edit tokens belong in the fragment, never in a path or query
string that a server or proxy could log.

## 2. Endpoints

### `POST /pass`: get a client pass

Body: `{ "token": "<Turnstile token>" }`. The server checks the token with
Turnstile's siteverify (each token works once and lasts 5 minutes), then
returns:

```json
{ "pass": "<id>.<expiresAt>.<signature>", "expiresAt": "2026-10-06T07:27:00.000Z" }
```

The pass is valid for 24 hours. The PWA keeps it in `localStorage` and
sends it as `X-Tallyup-Pass` on both POSTs below. It is signed with
`PASS_SECRET` and checked without touching the database.

Errors: `403 CHALLENGE_FAILED` if Turnstile says no, or if siteverify
can't be reached (the check fails closed). Limited to 300 per address per
hour.

### `POST /shares`: create (client pass)

Body (unknown fields are rejected):

```json
{ "ciphertext": "<base64url, ≤ 48000>", "iv": "<base64url, 16 chars>" }
```

`201`:

```json
{ "id": "cINDDMsWRIU8NA_7D5PXQQ", "editToken": "<43 chars>", "version": 1, "expiresAt": "2026-11-04T07:27:00.000Z" }
```

The edit token is returned **only here**. The server keeps a hash of it.
`401 PASS_REQUIRED` without a valid pass; the PWA then runs the check
again and retries once. Answers `503 AT_CAPACITY` when the database is
near its size cap; existing shares keep working.

### `GET /shares/{id}`: read

`200`: `{ id, ciphertext, iv, version, updatedAt, expiresAt, claims }`,
where `claims` is `[{ id, ciphertext, iv, createdAt }]`, oldest first, at
most 50. The share and its claims come back together so that opening an
event costs one request. `404` if the share is unknown or expired.

### `PUT /shares/{id}`: update (edit token)

`Authorization: Bearer <editToken>`

```json
{ "ciphertext": "…", "iv": "…", "version": 3 }
```

`version` is the version you last read. If it is stale, the response is
`409 VERSION_CONFLICT` with `details.currentVersion`: reload, re-apply and
retry. On success the response is `200 { version, expiresAt }`, and the
expiry moves to 30 days from now.

### `DELETE /shares/{id}`: delete (edit token)

`204`. Claims are deleted with the share.

### `POST /shares/{id}/claims`: add a claim (client pass)

Body: `{ ciphertext (≤ 2000), iv }`. Anyone holding the share id and a
pass may claim, because claims change nothing until the host confirms one.
Responses: `201 { id, createdAt }`, `409 CLAIM_LIMIT` once 50 claims are
waiting.

### `DELETE /shares/{id}/claims/{claimId}`: remove a claim (edit token)

`204`, or `404` if that claim does not belong to that share.

### Confirming a payment

There is no confirm endpoint, because the server cannot read a claim to
act on it. The host client does the following:

1. Decrypts the claim.
2. Appends `{ id, from, to, amount, at }` to the event's `settlements`.
3. `PUT`s the event.
4. `DELETE`s the claim.

Declining a claim is step 4 alone.

## 3. Rate limits

Per hour. "Per pass" means per verified browser, so people sharing one
network don't share one limit. "Per address" means per IPv4 address, or
per /64 prefix of an IPv6 address.

| Requests | Per pass | Per address (backstop) |
|---|---|---|
| `POST /pass` | — | 300 |
| `POST /shares` | 30 | 120 |
| `POST /shares/{id}/claims` | 20 | 120 |
| `PUT` and `DELETE` | — | 120 |
| `GET` | not limited | not limited |

A request over the limit gets `429 RATE_LIMITED` with `Retry-After` in
seconds. Reads are not limited in the app, because each check costs a
database write and the free daily write budget is shared by the whole app
(Architecture §3). Read floods are stopped at the edge instead
(Deployment §9).

## 4. Errors

One envelope, always:

```json
{ "error": { "code": "VERSION_CONFLICT", "message": "…", "details": { "currentVersion": 4 } } }
```

| Code | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 422 | Bad JSON, unknown field, malformed id, iv or ciphertext, or ciphertext over the cap. |
| `UNAUTHENTICATED` | 401 | Edit token missing. |
| `PASS_REQUIRED` | 401 | Client pass missing, expired or forged. |
| `FORBIDDEN` | 403 | Edit token wrong. |
| `CHALLENGE_FAILED` | 403 | Turnstile rejected the token, or siteverify was unreachable. |
| `NOT_FOUND` | 404 | Unknown or expired share, unknown claim, unknown endpoint. |
| `VERSION_CONFLICT` | 409 | Stale `version` on update. |
| `CLAIM_LIMIT` | 409 | 50 unanswered claims already waiting. |
| `PAYLOAD_TOO_LARGE` | 413 | Body over 64 KiB. |
| `RATE_LIMITED` | 429 | See §3. |
| `INTERNAL_ERROR` | 500 | A bug. Logged server-side; never carries detail. |
| `AT_CAPACITY` | 503 | Database near its size cap; only creation is refused. |

Responses that do **not** carry this envelope come from the platform, not
the app: typically the free daily request limit is used up. Treat them as
"try again later".

## 5. Trying it locally with curl

Locally, `.dev.vars` holds Cloudflare's always-pass Turnstile test secret,
so the documented dummy token `XXXX.DUMMY.TOKEN.XXXX` buys a pass. A
production secret rejects it. `node` does the encryption, using the scheme
in §1 without compression (readers accept both).

```bash
BASE=http://localhost:8787/v1
KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
field() { node -pe "JSON.parse(require('fs').readFileSync(0)).$1"; }

seal() {  # seal '<json>' -> {"ciphertext":..,"iv":..}
  node -e '
    const c = require("crypto"), key = Buffer.from(process.argv[1], "base64url");
    const iv = c.randomBytes(12), ci = c.createCipheriv("aes-256-gcm", key, iv);
    const out = Buffer.concat([ci.update(process.argv[2]), ci.final(), ci.getAuthTag()]);
    console.log(JSON.stringify({ ciphertext: out.toString("base64url"), iv: iv.toString("base64url") }));
  ' "$KEY" "$1"
}

PASS=$(curl -s -X POST $BASE/pass -H 'Content-Type: application/json' \
  -d '{"token":"XXXX.DUMMY.TOKEN.XXXX"}' | field pass)

DOC='{"v":1,"title":"Lunch","currency":"IDR","createdAt":0,
      "people":[{"id":"ana","name":"Ana"},{"id":"budi","name":"Budi"}],
      "bills":[{"id":"b1","name":"Warung","paidBy":"ana","tax":0,"service":0,"discount":0,
                "items":[{"name":"Nasi","price":50000,"qty":2,"for":[]}]}],
      "settlements":[]}'

SHARE=$(curl -s -X POST $BASE/shares -H 'Content-Type: application/json' \
  -H "X-Tallyup-Pass: $PASS" -d "$(seal "$DOC")")
ID=$(echo "$SHARE" | field id); TOKEN=$(echo "$SHARE" | field editToken)
echo "View link: http://localhost:8787/#/s/$ID/$KEY"

curl -s -X POST $BASE/shares/$ID/claims -H 'Content-Type: application/json' \
  -H "X-Tallyup-Pass: $PASS" -d "$(seal '{"from":"budi","to":"ana","amount":50000,"at":0}')"

curl -s -o /dev/null -w '%{http_code}\n' -X DELETE $BASE/shares/$ID -H "Authorization: Bearer $TOKEN"
```

Open the view link before the last line runs, and the PWA decrypts the
event, with Budi's pending claim.
