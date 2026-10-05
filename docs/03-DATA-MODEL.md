# Data model

Two layers: what the **server** stores (opaque), and what the **browser**
encrypts (the event document). Only the browser ever sees the second.

## 1. Server tables (D1)

Defined in `src/schema.ts`; migration in `migrations/0000_init.sql`.
Timestamps are unix milliseconds.

### `shares`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | 16 random bytes, base64url (22 chars). |
| `ciphertext` | text | AES-256-GCM output, base64url. ≤ 48,000 chars. |
| `iv` | text | 12-byte nonce, base64url (16 chars). Fresh on every save. |
| `edit_token_hash` | text | SHA-256 hex of the edit token. The token itself is never stored. |
| `version` | integer | Starts at 1, +1 per update. Used for compare-and-swap. |
| `created_at`, `updated_at` | integer | |
| `expires_at` | integer | `updated_at + 30 days`. Indexed for the sweep. |

### `share_claims`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | Same format as a share id. |
| `share_id` | text FK → `shares.id` | Indexed. Deleted with the share. |
| `ciphertext`, `iv` | text | An encrypted claim, ≤ 2,000 chars. |
| `created_at` | integer | |

At most 50 unanswered claims per share. The host deletes a claim once it is
confirmed or declined.

### `rate_limits`

| Column | Type | Notes |
|---|---|---|
| `key` | text PK | `scope:ip:windowStart`. |
| `count` | integer | |
| `expires_at` | integer | Swept daily. |

### Lifecycle

- Reads treat `expires_at < now` as not found, so expiry is exact even
  before the sweep runs.
- The cron trigger (`0 3 * * *`) deletes expired shares, their claims, and
  expired rate-limit windows (`sweepExpired` in `src/index.ts`).
- Deleting a share deletes its claims first, in one batch.

## 2. The event document (encrypted)

Defined and validated by `web/src/lib/doc.ts`. Money is **whole rupiah**
(integers). There are no floats anywhere in the document.

```ts
{
  v: 1,
  title: string,                  // 1–80
  currency: 'IDR',
  createdAt: number,
  people: [{                      // 1–30
    id: string,                   // [A-Za-z0-9_-]{1,24}
    name: string,                 // 1–40
    payment?: {
      bankName: string,           // 1–40
      accountNumber: string,      // digits, 4–24
      accountHolder?: string      // ≤ 60, shown only when non-empty
    }
  }],
  bills: [{                       // ≤ 10
    id: string,
    name: string,
    paidBy: personId,
    items: [{                     // ≤ 60
      name: string,               // ≤ 80
      price: number,              // unit price, 0–50,000,000
      qty: number,                // 1–99
      for: personId[]             // [] = everyone
    }],
    tax: number, service: number, discount: number   // as printed
  }],
  settlements: [{                 // confirmed payments, ≤ 200
    id: string, from: personId, to: personId, amount: number, at: number
  }]
}
```

Validation also checks that every `paidBy`, `for`, `from` and `to` names a
person in the event, that person ids are unique, and that nobody pays
themselves. Unknown fields are rejected at every level.

### Claim document (encrypted)

```ts
{ from: personId, to: personId, amount: number, at: number }
```

## 3. How balances are derived

Balances are never stored. They are recomputed from the document on every
render (`web/src/lib/split.ts`):

1. **Per item:** `price × qty`, split equally among `for` (or everyone).
2. **Per bill:** `total = subtotal + tax + service − discount`, then the
   whole total is split in proportion to each person's item subtotal. This
   is one `resolveSplit(total, { type: 'shares' })` call, so charges follow
   consumption and the result sums to the exact total.
3. **Per event:** each valid bill becomes an expense paid by `paidBy`. Each
   settlement becomes an expense the payer covered entirely for the
   recipient. `calculateBalances` nets them, and `simplifyDebts` returns the
   fewest transfers.

A bill with no items, or with a discount larger than itself, is marked
invalid and excluded from the totals. It is never allowed to produce
negative debt.
