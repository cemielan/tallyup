# API Specification

Base URL: `https://<your-worker>.workers.dev/v1` (or your custom domain).
All requests and responses are JSON. All authenticated endpoints require
`Authorization: Bearer <access_token>`.

This document is the human-readable source of truth; the actual OpenAPI
JSON served by the API (NFR-301) is generated from the same Zod schemas
used to implement these routes — if they ever disagree, the generated
spec (and the code) wins, and this doc should be updated to match.

## 1. Conventions

### Error format

Every error response, regardless of status code, uses this envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "amount must be a positive integer",
    "details": { "field": "amount" }
  }
}
```

`code` is a stable, machine-matchable string (see §5 for the full list).
`details` is optional and shape varies by `code` — never parse it without
checking `code` first.

### Pagination

List endpoints accept `?page=1&pageSize=20` (default `page=1`,
`pageSize=20`, max `pageSize=100` — NFR-203) and respond with:

```json
{
  "data": [ /* items */ ],
  "pagination": { "page": 1, "pageSize": 20, "total": 47, "totalPages": 3 }
}
```

### Money

All amounts are integers in minor currency units. `1050` means $10.50
for a two-decimal currency. The API never accepts or returns decimal
strings for money — that conversion belongs at the UI edge, consistent
with the `debt-simplify` library's own design notes.

## 2. Auth

### `POST /v1/auth/register`

Request:
```json
{ "email": "alice@example.com", "password": "correct horse battery staple", "displayName": "Alice" }
```
`201 Created`:
```json
{ "user": { "id": "...", "email": "alice@example.com", "displayName": "Alice" } }
```
Errors: `409 EMAIL_TAKEN`, `422 VALIDATION_ERROR` (weak password, FR-102).

### `POST /v1/auth/login`

Request: `{ "email": "...", "password": "..." }`
`200 OK`:
```json
{
  "accessToken": "eyJ...",
  "refreshToken": "8f2c...",
  "expiresIn": 900,
  "user": { "id": "...", "email": "...", "displayName": "..." }
}
```
Errors: `401 INVALID_CREDENTIALS` (deliberately identical for "no such
user" and "wrong password" — see Security doc, no user enumeration).

### `POST /v1/auth/refresh`

Request: `{ "refreshToken": "..." }`
`200 OK`: same shape as login, with a **new** refresh token (rotation —
see Security doc). Errors: `401 INVALID_REFRESH_TOKEN`.

### `POST /v1/auth/logout`

Requires auth. Request: `{ "refreshToken": "..." }` → revokes that token.
`204 No Content`.

### `POST /v1/auth/logout-all`

Requires auth. Revokes every refresh token for the caller. `204 No Content`.

### `GET /v1/users/me`

Requires auth. `200 OK`: `{ "id": "...", "email": "...", "displayName": "..." }`

### `PATCH /v1/users/me`

Requires auth. Request: `{ "displayName": "..." }` → `200 OK` updated user.

## 3. Groups

### `POST /v1/groups`

Requires auth. Request: `{ "name": "Bali Trip" }`
`201 Created`:
```json
{ "id": "...", "name": "Bali Trip", "inviteCode": "BALI-7X2K", "role": "owner" }
```

### `GET /v1/groups`

Requires auth. Paginated list of groups the caller belongs to.

### `GET /v1/groups/:groupId`

Requires membership. `200 OK`:
```json
{
  "id": "...", "name": "Bali Trip",
  "members": [{ "id": "...", "displayName": "Alice", "role": "owner" }],
  "createdAt": "2026-06-01T00:00:00Z"
}
```
Errors: `403 FORBIDDEN` if caller isn't a member (never `404` here for
non-members — see Security doc on not leaking group existence... actually
`404 NOT_FOUND` is used deliberately instead of `403` for non-members, to
avoid confirming the group ID exists at all to someone who isn't in it).

### `POST /v1/groups/join`

Requires auth. Request: `{ "inviteCode": "BALI-7X2K" }` → `200 OK`, joins
as `member`. Errors: `404 INVALID_INVITE_CODE`, `409 ALREADY_MEMBER`.

### `POST /v1/groups/:groupId/invite/rotate`

Requires `owner` role. `200 OK`: `{ "inviteCode": "NEW-CODE" }` (FR-207).

### `DELETE /v1/groups/:groupId/members/:userId`

Requires `owner` role (or the caller removing themself — this endpoint
also serves "leave group", FR-206). Errors: `409 NONZERO_BALANCE` if the
member has an outstanding balance (FR-205/206).

## 4. Expenses

### `POST /v1/groups/:groupId/expenses`

Requires membership. Request:
```json
{
  "amount": 12000,
  "currency": "USD",
  "description": "Hotel",
  "paidBy": "user-id-of-alice",
  "split": { "type": "equal", "participants": ["user-id-alice", "user-id-bob"] }
}
```
`201 Created`: the created expense with resolved per-person split
amounts. Errors: `422 VALIDATION_ERROR` (e.g. exact/percentage split
doesn't sum correctly — mirrors the errors `calculateBalances` itself
throws), `422 NON_MEMBER_PARTICIPANT` (FR-303).

### `GET /v1/groups/:groupId/expenses`

Requires membership. Paginated, newest first (FR-304).

### `GET /v1/expenses/:expenseId`

Requires membership in the expense's group.

### `PATCH /v1/expenses/:expenseId`

Requires the expense's `createdBy` or the group `owner` (FR-306).
Same body shape as create; partial updates allowed.

### `DELETE /v1/expenses/:expenseId`

Requires the expense's `createdBy` or the group `owner` (FR-307). Soft
delete (§Data Model) → `204 No Content`.

## 5. Balances & Settlements

### `GET /v1/groups/:groupId/balances`

Requires membership. `200 OK`:
```json
{ "balances": [{ "userId": "...", "displayName": "Alice", "amount": 6000, "currency": "USD" }] }
```
One array entry per (user, currency) pair with a non-zero balance.

### `GET /v1/groups/:groupId/settlements/suggested`

Requires membership. Runs `simplifyDebtsMulti` over current balances.
`200 OK`:
```json
{ "suggested": [{ "from": "user-id-dave", "to": "user-id-alice", "amount": 6000, "currency": "USD" }] }
```
This is always computed fresh from current balances — it is not a
stored resource, so it has no ID and can't be fetched by one.

### `POST /v1/groups/:groupId/settlements`

Requires membership. Request: `{ "toUserId": "...", "amount": 6000, "currency": "USD" }`
Creates a `pending` settlement record from the caller to `toUserId`.
`201 Created`.

### `POST /v1/settlements/:settlementId/confirm`

Requires the settlement's `toUserId` (the receiving party — FR-404, only
the person being paid can confirm they received it). Creates the
balancing `is_settlement: true` expense, sets status to `confirmed`.
`200 OK`.

### `POST /v1/settlements/:settlementId/decline`

Requires the settlement's `toUserId`. Sets status to `declined`, no
balance change. `200 OK`.

## Error code reference

| `code` | HTTP status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 422 | Request body failed schema validation |
| `UNAUTHENTICATED` | 401 | Missing or invalid access token |
| `INVALID_CREDENTIALS` | 401 | Login failed (deliberately generic) |
| `INVALID_REFRESH_TOKEN` | 401 | Refresh token invalid, expired, or revoked |
| `FORBIDDEN` | 403 | Authenticated but not permitted (e.g. not group owner) |
| `NOT_FOUND` | 404 | Resource doesn't exist, or caller isn't authorized to know it does |
| `EMAIL_TAKEN` | 409 | Registration with an existing email |
| `ALREADY_MEMBER` | 409 | Joining a group you're already in |
| `NONZERO_BALANCE` | 409 | Leaving/removing a member with an outstanding balance |
| `NON_MEMBER_PARTICIPANT` | 422 | Expense references a user not in the group |
| `RATE_LIMITED` | 429 | Rate limit exceeded — see `Retry-After` header |
| `INTERNAL_ERROR` | 500 | Unexpected server error — logged server-side, generic message to client |
