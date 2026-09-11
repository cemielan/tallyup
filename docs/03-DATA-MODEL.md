# Data Model

All monetary amounts are **integers in minor currency units** (cents,
sen, etc.) — never floats — matching the `debt-simplify` library's own
convention. This keeps the API and the library speaking the same
language with zero conversion at the boundary.

## 1. Entity relationship overview

```
users ──< group_members >── groups
  │                            │
  │                            ├──< expenses >── expense_splits
  │                            │        │
  └──< refresh_tokens          │        └── (paidBy: users.id)
                                └──< settlements
```

- A `user` can belong to many `groups` (via `group_members`).
- A `group` has many `expenses`; each `expense` has many `expense_splits`
  (one row per participant's share).
- A `settlement` is a confirmed record that a suggested payment
  (from `simplifyDebts`) was actually made — it is **not** the same as
  an `expense`, but confirming one creates a corresponding balancing
  expense so `calculateBalances` stays the single source of truth for
  "who owes what" (see FR-403, FR-408).

## 2. Tables

### `users`

| Column | Type | Constraints |
|---|---|---|
| `id` | text (UUID) | primary key |
| `email` | text | unique, not null |
| `password_hash` | text | not null — see Security doc for algorithm |
| `display_name` | text | not null |
| `created_at` | integer (unix ms) | not null |

Index: unique index on `email` (needed for login lookup and to enforce
uniqueness — do both with one index, not two).

### `refresh_tokens`

| Column | Type | Constraints |
|---|---|---|
| `id` | text (UUID) | primary key |
| `user_id` | text | FK → `users.id`, not null |
| `token_hash` | text | not null — store a hash of the token, never the raw token (see Security doc) |
| `expires_at` | integer (unix ms) | not null |
| `revoked_at` | integer (unix ms) | nullable |
| `created_at` | integer (unix ms) | not null |

Index: on `user_id` (needed for "revoke all sessions", FR-106) and on
`token_hash` (needed for the refresh lookup on every `POST /auth/refresh`
call).

### `groups`

| Column | Type | Constraints |
|---|---|---|
| `id` | text (UUID) | primary key |
| `name` | text | not null |
| `invite_code` | text | unique, not null |
| `created_by` | text | FK → `users.id`, not null |
| `created_at` | integer (unix ms) | not null |

Index: unique index on `invite_code` (looked up on every join attempt —
this is also an anti-enumeration surface, see Security doc).

### `group_members`

| Column | Type | Constraints |
|---|---|---|
| `group_id` | text | FK → `groups.id`, not null |
| `user_id` | text | FK → `users.id`, not null |
| `role` | text | not null, `'owner' \| 'member'` |
| `joined_at` | integer (unix ms) | not null |

Primary key: composite (`group_id`, `user_id`).
Index: on `user_id` alone (needed for "list my groups", FR-203 — the
composite PK alone doesn't serve a user_id-only lookup efficiently).

### `expenses`

| Column | Type | Constraints |
|---|---|---|
| `id` | text (UUID) | primary key |
| `group_id` | text | FK → `groups.id`, not null |
| `paid_by` | text | FK → `users.id`, not null |
| `created_by` | text | FK → `users.id`, not null — may differ from `paid_by` |
| `amount` | integer | not null, > 0 |
| `currency` | text | not null, ISO 4217 code, e.g. `"USD"` |
| `description` | text | not null |
| `split_type` | text | not null, `'equal' \| 'exact' \| 'percentage' \| 'shares'` |
| `is_settlement` | boolean | not null, default false — true for the balancing expense created by confirming a settlement (FR-403), so the UI can distinguish "real" expenses from settlement records |
| `created_at` | integer (unix ms) | not null |
| `updated_at` | integer (unix ms) | not null |
| `deleted_at` | integer (unix ms) | nullable — soft delete, see note below |

Index: on `group_id` (list expenses, FR-304 — this is the hottest query
path in the app) and on `(group_id, created_at)` composite for the
paginated "newest first" ordering to avoid a sort at read time.

**Soft delete rationale:** expenses are financial records; hard-deleting
them destroys audit history a real settlement app should keep. Deleted
expenses are excluded from `calculateBalances` input but retained in the
table. `DELETE /v1/expenses/:id` sets `deleted_at`, it does not `DROP` the
row.

### `expense_splits`

| Column | Type | Constraints |
|---|---|---|
| `id` | text (UUID) | primary key |
| `expense_id` | text | FK → `expenses.id`, not null |
| `user_id` | text | FK → `users.id`, not null |
| `amount` | integer | not null — this participant's resolved share in minor units, already computed by `calculateBalances`'s split logic at write time |

Index: on `expense_id` (needed every time an expense is read or a
group's balances are recomputed).

**Why store resolved amounts, not the raw split config:** if a
`percentage` split's underlying percentages were re-interpreted after
the fact (e.g. a library bug fix changes rounding behavior), historical
expenses would silently change value. Storing the resolved integer
amounts at creation time makes every expense immutable in effect, which
is what FR-308 ("balances are always derived, never independently
mutated") implicitly requires for *historical* correctness, while still
deriving current balances live by summing these rows.

### `settlements`

| Column | Type | Constraints |
|---|---|---|
| `id` | text (UUID) | primary key |
| `group_id` | text | FK → `groups.id`, not null |
| `from_user_id` | text | FK → `users.id`, not null |
| `to_user_id` | text | FK → `users.id`, not null |
| `amount` | integer | not null |
| `currency` | text | not null |
| `status` | text | not null, `'pending' \| 'confirmed' \| 'declined'` |
| `confirming_expense_id` | text | FK → `expenses.id`, nullable — set once confirmed (FR-403) |
| `created_at` | integer (unix ms) | not null |
| `resolved_at` | integer (unix ms) | nullable |

Index: on `(group_id, status)` — the settlements list/confirmation flow
always filters by group and usually by pending status.

## 3. Query patterns to design around

These are the shapes NFR-204 ("index every FK lookup and list filter")
is protecting:

1. **Get a group's current balances** — read all non-deleted expenses
   and their splits for a group, feed into `calculateBalances`. This is
   the single most performance-sensitive read (§NFR-201/202) — it's an
   `O(expenses × avg splits per expense)` scan, so the `(group_id,
   created_at)` index on `expenses` and the `expense_id` index on
   `expense_splits` both matter directly.
2. **List my groups** — `group_members` filtered by `user_id`.
3. **Authorization check on every group/expense route** — "is this
   caller a member of this group?" — a `group_members` lookup by
   composite PK, which is already indexed by definition. This check
   MUST run before any group-scoped data is read or written (NFR-102).
