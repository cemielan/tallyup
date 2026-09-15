/**
 * LOCAL PLACEHOLDER for the published `debt-simplify` package.
 *
 * FR-501 requires that all debt-simplification math lives in the published
 * library and is never reimplemented inside the API layer. The published
 * package was not available when this repo was scaffolded, so this workspace
 * package stands in for it: same module name, same import path, same call
 * signatures. Point the dependency in the root package.json at the real
 * version and delete this directory -- no API-layer code should need to
 * change, because nothing outside this package knows how the math works.
 *
 * If the real package's signatures differ from the ones below, adjust the
 * thin call sites in `src/balances.ts` only.
 */

/** A participant's identity. Opaque to this library. */
export type ParticipantId = string;

/** All amounts are integers in minor currency units (cents, sen). */
export type Split =
  | { type: 'equal'; participants: ParticipantId[] }
  | { type: 'exact'; amounts: Record<ParticipantId, number> }
  | { type: 'percentage'; percentages: Record<ParticipantId, number> }
  | { type: 'shares'; shares: Record<ParticipantId, number> };

export interface ExpenseInput {
  paidBy: ParticipantId;
  /** Total in minor units. Must be a positive integer. */
  amount: number;
  split: Split;
}

/** Net position per participant. Positive = is owed, negative = owes. */
export type Balances = Record<ParticipantId, number>;

export interface Transfer {
  from: ParticipantId;
  to: ParticipantId;
  amount: number;
}

export class DebtSimplifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DebtSimplifyError';
  }
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new DebtSimplifyError(`${label} must be a positive integer in minor units`);
  }
}

/**
 * Distribute `total` across `weights` proportionally, using the
 * largest-remainder method so the parts always sum to exactly `total`.
 * Without this, naive rounding leaks or invents a minor unit per expense.
 */
function distribute(
  total: number,
  weights: Array<[ParticipantId, number]>,
): Record<ParticipantId, number> {
  const weightSum = weights.reduce((sum, [, w]) => sum + w, 0);
  if (weightSum <= 0) {
    throw new DebtSimplifyError('split weights must sum to a positive value');
  }

  const out: Record<ParticipantId, number> = {};
  const remainders: Array<{ id: ParticipantId; remainder: number }> = [];
  let allocated = 0;

  for (const [id, weight] of weights) {
    const exact = (total * weight) / weightSum;
    const floored = Math.floor(exact);
    out[id] = floored;
    allocated += floored;
    remainders.push({ id, remainder: exact - floored });
  }

  // Hand the leftover minor units to the largest remainders, ties broken by
  // id so the result is deterministic for a given input.
  remainders.sort((a, b) => b.remainder - a.remainder || (a.id < b.id ? -1 : 1));
  for (let i = 0; i < total - allocated; i += 1) {
    out[remainders[i % remainders.length].id] += 1;
  }

  return out;
}

/**
 * Resolve a split definition into exact integer amounts per participant.
 * Throws `DebtSimplifyError` when the split cannot be satisfied.
 */
export function resolveSplit(total: number, split: Split): Record<ParticipantId, number> {
  assertPositiveInt(total, 'amount');

  switch (split.type) {
    case 'equal': {
      if (split.participants.length === 0) {
        throw new DebtSimplifyError('an equal split needs at least one participant');
      }
      if (new Set(split.participants).size !== split.participants.length) {
        throw new DebtSimplifyError('an equal split cannot repeat a participant');
      }
      return distribute(
        total,
        split.participants.map((id) => [id, 1] as [ParticipantId, number]),
      );
    }

    case 'exact': {
      const entries = Object.entries(split.amounts);
      if (entries.length === 0) {
        throw new DebtSimplifyError('an exact split needs at least one participant');
      }
      let sum = 0;
      for (const [id, amount] of entries) {
        if (!Number.isInteger(amount) || amount < 0) {
          throw new DebtSimplifyError(`exact split amount for ${id} must be a non-negative integer`);
        }
        sum += amount;
      }
      if (sum !== total) {
        throw new DebtSimplifyError(`exact split amounts sum to ${sum}, expected ${total}`);
      }
      return { ...split.amounts };
    }

    case 'percentage': {
      const entries = Object.entries(split.percentages);
      if (entries.length === 0) {
        throw new DebtSimplifyError('a percentage split needs at least one participant');
      }
      let sum = 0;
      for (const [id, pct] of entries) {
        if (!Number.isFinite(pct) || pct < 0) {
          throw new DebtSimplifyError(`percentage for ${id} must be a non-negative number`);
        }
        sum += pct;
      }
      // Tolerate float dust from clients sending e.g. 33.33 + 33.33 + 33.34.
      if (Math.abs(sum - 100) > 0.01) {
        throw new DebtSimplifyError(`percentages sum to ${sum}, expected 100`);
      }
      return distribute(total, entries);
    }

    case 'shares': {
      const entries = Object.entries(split.shares);
      if (entries.length === 0) {
        throw new DebtSimplifyError('a shares split needs at least one participant');
      }
      for (const [id, shares] of entries) {
        if (!Number.isInteger(shares) || shares < 0) {
          throw new DebtSimplifyError(`share count for ${id} must be a non-negative integer`);
        }
      }
      return distribute(total, entries);
    }

    default: {
      const exhaustive: never = split;
      throw new DebtSimplifyError(`unknown split type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Net every expense down to one balance per participant.
 * The returned balances always sum to zero. Zero balances are omitted.
 */
export function calculateBalances(expenses: ExpenseInput[]): Balances {
  const balances: Balances = {};
  const credit = (id: ParticipantId, delta: number) => {
    balances[id] = (balances[id] ?? 0) + delta;
  };

  for (const expense of expenses) {
    credit(expense.paidBy, expense.amount);

    // Fast path for `exact`, which is the shape a caller storing resolved
    // shares replays them in. `resolveSplit` would validate the sum, copy
    // the whole map, and hand back an equivalent object; here the same
    // validation happens in the single pass that applies the debits. Over a
    // large ledger that copy per expense is most of the work.
    if (expense.split.type === 'exact') {
      assertPositiveInt(expense.amount, 'amount');
      let sum = 0;
      let participants = 0;
      for (const id in expense.split.amounts) {
        // `for...in` walks the prototype chain; `Object.entries` does not.
        // Guarding keeps this path's semantics identical to the slow one
        // for any object a caller hands in.
        if (!Object.hasOwn(expense.split.amounts, id)) continue;
        const share = expense.split.amounts[id];
        if (!Number.isInteger(share) || share < 0) {
          throw new DebtSimplifyError(
            `exact split amount for ${id} must be a non-negative integer`,
          );
        }
        sum += share;
        participants += 1;
        credit(id, -share);
      }
      if (participants === 0) {
        throw new DebtSimplifyError('an exact split needs at least one participant');
      }
      if (sum !== expense.amount) {
        throw new DebtSimplifyError(`exact split amounts sum to ${sum}, expected ${expense.amount}`);
      }
      continue;
    }

    const shares = resolveSplit(expense.amount, expense.split);
    for (const id in shares) {
      if (!Object.hasOwn(shares, id)) continue;
      credit(id, -shares[id]);
    }
  }

  for (const id of Object.keys(balances)) {
    if (balances[id] === 0) delete balances[id];
  }
  return balances;
}

/**
 * Greedy minimal-transfer settlement: repeatedly match the largest debtor
 * against the largest creditor. Produces at most n-1 transfers for n people
 * holding a non-zero balance, which is the practical optimum -- the exactly
 * minimal set is NP-hard, and the difference does not show up at the group
 * sizes this app permits (NFR-202 caps groups at 50 members).
 */
export function simplifyDebts(balances: Balances): Transfer[] {
  const debtors: Array<[ParticipantId, number]> = [];
  const creditors: Array<[ParticipantId, number]> = [];

  for (const [id, amount] of Object.entries(balances)) {
    if (amount < 0) debtors.push([id, -amount]);
    else if (amount > 0) creditors.push([id, amount]);
  }

  const total = (xs: Array<[ParticipantId, number]>) => xs.reduce((s, [, a]) => s + a, 0);
  if (total(debtors) !== total(creditors)) {
    throw new DebtSimplifyError('balances do not sum to zero; cannot settle');
  }

  // Sort descending, ties broken by id, so the transfer list is deterministic.
  const byAmountDesc = (a: [ParticipantId, number], b: [ParticipantId, number]) =>
    b[1] - a[1] || (a[0] < b[0] ? -1 : 1);
  debtors.sort(byAmountDesc);
  creditors.sort(byAmountDesc);

  const transfers: Transfer[] = [];
  let d = 0;
  let c = 0;
  while (d < debtors.length && c < creditors.length) {
    const amount = Math.min(debtors[d][1], creditors[c][1]);
    if (amount > 0) {
      transfers.push({ from: debtors[d][0], to: creditors[c][0], amount });
    }
    debtors[d][1] -= amount;
    creditors[c][1] -= amount;
    if (debtors[d][1] === 0) d += 1;
    if (creditors[c][1] === 0) c += 1;
  }

  return transfers;
}

/**
 * Per-currency settlement. Currencies are never netted against each other
 * (FR-405) -- each one settles independently.
 */
export function simplifyDebtsMulti(
  balancesByCurrency: Record<string, Balances>,
): Record<string, Transfer[]> {
  const out: Record<string, Transfer[]> = {};
  for (const [currency, balances] of Object.entries(balancesByCurrency)) {
    out[currency] = simplifyDebts(balances);
  }
  return out;
}
