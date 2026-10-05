# API specification

Base URL: `https://<your-worker>/v1`. JSON in, JSON out. The live OpenAPI
document is at `/v1/openapi.json`, and an interactive reference is at
`/docs`. Both are generated from the same Zod schemas the routes enforce.

The API is open. Any origin may call it (`Access-Control-Allow-Origin: *`),
and no account or API key is needed. The only credential is a share's
**edit token**.

## 1. Encryption scheme (what a client must implement)

The server stores what you send and never decrypts it. To interoperate with
the Tallyup PWA, a client MUST:

| Part | Specification |
|---|---|
| Key | 32 random bytes from a CSPRNG. Text form: base64url, no padding (43 chars). |
| Cipher | AES-256-GCM, 128-bit tag (the WebCrypto default). No additional authenticated data. |
| IV | 12 random bytes, **fresh for every encryption**. Never reuse one under the same key. Text form: base64url, no padding (16 chars). |
| Plaintext | UTF-8 JSON of the event document (`docs/03-DATA-MODEL.md` §2) or a claim document. |
| Ciphertext | The cipher output with the tag appended, as WebCrypto returns it. Text form: base64url, no padding. |
| View link | `https://<host>/#/s/<shareId>/<key>` |
| Host link | `https://<host>/#/e/<shareId>/<key>/<editToken>` |

Keys and edit tokens belong in the fragment, never in a path or query
string that a server or proxy could log.

A reference implementation is `web/src/lib/crypto.ts` (about 50 lines). It
runs unchanged in browsers, Node 20+, Deno and Workers.

## 2. Endpoints

### `POST /shares`: create

Body (unknown fields are rejected):

```json
{ "ciphertext": "<base64url, ≤ 48000>", "iv": "<base64url, 16 chars>" }
```

`201`:

```json
{ "id": "cINDDMsWRIU8NA_7D5PXQQ", "editToken": "<43 chars>", "version": 1, "expiresAt": "2026-11-04T07:27:00.000Z" }
```

The edit token is returned **only here**. The server keeps a hash of it.
Limited to 30 per IP per hour.

### `GET /shares/{id}`: read

`200`: `{ id, ciphertext, iv, version, updatedAt, expiresAt }`. `404` if the
share is unknown or expired.

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

### `GET /shares/{id}/claims`: list claims

`200 { claims: [{ id, ciphertext, iv, createdAt }] }`, oldest first. There
are at most 50 claims, so the list is never paginated.

### `POST /shares/{id}/claims`: add a claim

Body: `{ ciphertext (≤ 2000), iv }`. Anyone holding the share id may
claim, because claims change nothing until the host confirms one.
Responses: `201 { id, createdAt }`, `409 CLAIM_LIMIT` once 50 claims are
waiting. Limited to 20 per IP per hour.

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

Every IP gets 120 requests per minute across `/v1/shares`. Creation and
claims have the tighter limits above. A request over the limit gets
`429 RATE_LIMITED` with `Retry-After` in seconds.

## 4. Errors

One envelope, always:

```json
{ "error": { "code": "VERSION_CONFLICT", "message": "…", "details": { "currentVersion": 4 } } }
```

| Code | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 422 | Bad JSON, unknown field, malformed id, iv or ciphertext, or ciphertext over the cap. |
| `UNAUTHENTICATED` | 401 | Edit token missing. |
| `FORBIDDEN` | 403 | Edit token wrong. |
| `NOT_FOUND` | 404 | Unknown or expired share, unknown claim, unknown endpoint. |
| `VERSION_CONFLICT` | 409 | Stale `version` on update. |
| `CLAIM_LIMIT` | 409 | 50 unanswered claims already waiting. |
| `PAYLOAD_TOO_LARGE` | 413 | Body over 64 KiB. |
| `RATE_LIMITED` | 429 | See §3. |
| `INTERNAL_ERROR` | 500 | A bug. Logged server-side; never carries detail. |

## 5. A full flow with curl

The server never decrypts anything, so a curl walkthrough shows the
transport only. `node` does the encryption here, using the same scheme as
§1.

```bash
BASE=http://localhost:8787/v1
KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")

seal() {  # seal '<json>' -> {"ciphertext":..,"iv":..}
  node -e '
    const c = require("crypto"), key = Buffer.from(process.argv[1], "base64url");
    const iv = c.randomBytes(12), ci = c.createCipheriv("aes-256-gcm", key, iv);
    const out = Buffer.concat([ci.update(process.argv[2]), ci.final(), ci.getAuthTag()]);
    console.log(JSON.stringify({ ciphertext: out.toString("base64url"), iv: iv.toString("base64url") }));
  ' "$KEY" "$1"
}

DOC='{"v":1,"title":"Lunch","currency":"IDR","createdAt":0,
      "people":[{"id":"ana","name":"Ana"},{"id":"budi","name":"Budi"}],
      "bills":[{"id":"b1","name":"Warung","paidBy":"ana","tax":0,"service":0,"discount":0,
                "items":[{"name":"Nasi","price":50000,"qty":2,"for":[]}]}],
      "settlements":[]}'

# 1. Create. Keep the edit token.
SHARE=$(curl -s -X POST $BASE/shares -H 'Content-Type: application/json' -d "$(seal "$DOC")")
ID=$(echo "$SHARE" | jq -r .id); TOKEN=$(echo "$SHARE" | jq -r .editToken)
echo "View link: http://localhost:8787/#/s/$ID/$KEY"

# 2. Budi claims a payment.
curl -s -X POST $BASE/shares/$ID/claims -H 'Content-Type: application/json' \
  -d "$(seal '{"from":"budi","to":"ana","amount":50000,"at":0}')"

# 3. Anyone with the id can read the ciphertext. Only the key opens it.
curl -s $BASE/shares/$ID | jq '{version, expiresAt}'

# 4. Delete with the edit token.
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE $BASE/shares/$ID -H "Authorization: Bearer $TOKEN"
```

Open the view link from step 1 in a browser and the PWA decrypts and
renders the event you created from the shell.
