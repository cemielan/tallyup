import { DebtSimplifyError, calculateBalances, resolveSplit, simplifyDebts, simplifyDebtsMulti } from 'debt-simplify';
import { describe, expect, it } from 'vitest';

// The library's own suite. Tallyup's web tests exercise it through real
// events; this file pins its contract, so a library change that alters
// behavior fails here first.
describe('resolveSplit', () => {
  it('never loses or invents a minor unit on an indivisible total', () => {
    const shares = resolveSplit(100, { type: 'equal', participants: ['a', 'b', 'c'] });
    expect(Object.values(shares).reduce((a, b) => a + b, 0)).toBe(100);
    expect(Object.values(shares).sort()).toEqual([33, 33, 34]);
  });

  it('rejects an exact split that does not sum to the total', () => {
    expect(() => resolveSplit(1000, { type: 'exact', amounts: { a: 400, b: 500 } })).toThrow(
      DebtSimplifyError,
    );
  });

  it('rejects percentages that do not sum to 100', () => {
    expect(() =>
      resolveSplit(1000, { type: 'percentage', percentages: { a: 50, b: 30 } }),
    ).toThrow(DebtSimplifyError);
  });

  it('tolerates the float dust in 33.33 / 33.33 / 33.34', () => {
    const shares = resolveSplit(9999, {
      type: 'percentage',
      percentages: { a: 33.33, b: 33.33, c: 33.34 },
    });
    expect(Object.values(shares).reduce((a, b) => a + b, 0)).toBe(9999);
  });

  it('weights a shares split proportionally', () => {
    expect(resolveSplit(900, { type: 'shares', shares: { a: 1, b: 2 } })).toEqual({
      a: 300,
      b: 600,
    });
  });
});

describe('calculateBalances', () => {
  it('sums to zero and omits settled participants', () => {
    const balances = calculateBalances([
      { paidBy: 'alice', amount: 3000, split: { type: 'equal', participants: ['alice', 'bob'] } },
      { paidBy: 'bob', amount: 3000, split: { type: 'equal', participants: ['alice', 'bob'] } },
    ]);
    expect(balances).toEqual({});
  });
});

describe('simplifyDebts', () => {
  it('settles three people in two transfers', () => {
    const transfers = simplifyDebts({ alice: 6000, bob: -2000, dave: -4000 });
    expect(transfers).toHaveLength(2);
    expect(transfers.every((t) => t.to === 'alice')).toBe(true);
    expect(transfers.reduce((sum, t) => sum + t.amount, 0)).toBe(6000);
  });

  it('refuses balances that do not sum to zero', () => {
    expect(() => simplifyDebts({ alice: 100, bob: -50 })).toThrow(DebtSimplifyError);
  });
});

describe('validation', () => {
  const bad: Array<[string, () => unknown]> = [
    ['non-integer total', () => resolveSplit(10.5, { type: 'equal', participants: ['a'] })],
    ['zero total', () => resolveSplit(0, { type: 'equal', participants: ['a'] })],
    ['empty equal split', () => resolveSplit(100, { type: 'equal', participants: [] })],
    ['repeated participant', () => resolveSplit(100, { type: 'equal', participants: ['a', 'a'] })],
    ['empty exact split', () => resolveSplit(100, { type: 'exact', amounts: {} })],
    ['negative exact share', () => resolveSplit(100, { type: 'exact', amounts: { a: 150, b: -50 } })],
    ['empty percentage split', () => resolveSplit(100, { type: 'percentage', percentages: {} })],
    ['negative percentage', () => resolveSplit(100, { type: 'percentage', percentages: { a: 150, b: -50 } })],
    ['empty shares split', () => resolveSplit(100, { type: 'shares', shares: {} })],
    ['fractional share count', () => resolveSplit(100, { type: 'shares', shares: { a: 1.5 } })],
    ['all-zero weights', () => resolveSplit(100, { type: 'shares', shares: { a: 0, b: 0 } })],
    ['unknown split type', () => resolveSplit(100, { type: 'nope' } as never)],
  ];

  it.each(bad)('rejects %s', (_, run) => {
    expect(run).toThrow(DebtSimplifyError);
  });

  it('applies the same checks on the exact fast path in calculateBalances', () => {
    const exact = (amounts: Record<string, number>, amount = 100) => () =>
      calculateBalances([{ paidBy: 'a', amount, split: { type: 'exact', amounts } }]);
    expect(exact({ b: 100 }, 0)).toThrow(DebtSimplifyError);
    expect(exact({ b: -1, c: 101 })).toThrow(DebtSimplifyError);
    expect(exact({})).toThrow(DebtSimplifyError);
    expect(exact({ b: 99 })).toThrow(DebtSimplifyError);
  });

  it('ignores inherited keys on the exact fast path', () => {
    const amounts = Object.create({ inherited: 5 }) as Record<string, number>;
    amounts.b = 100;
    expect(calculateBalances([{ paidBy: 'a', amount: 100, split: { type: 'exact', amounts } }])).toEqual({
      a: 100,
      b: -100,
    });
  });

  it('nets non-exact splits through resolveSplit', () => {
    expect(
      calculateBalances([{ paidBy: 'a', amount: 300, split: { type: 'shares', shares: { a: 1, b: 2 } } }]),
    ).toEqual({ a: 200, b: -200 });
  });
});

describe('simplifyDebtsMulti', () => {
  it('settles each currency on its own', () => {
    expect(simplifyDebtsMulti({ IDR: { a: 500, b: -500 }, USD: { b: 3, a: -3 } })).toEqual({
      IDR: [{ from: 'b', to: 'a', amount: 500 }],
      USD: [{ from: 'a', to: 'b', amount: 3 }],
    });
  });
});
