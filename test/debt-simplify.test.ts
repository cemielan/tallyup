import { DebtSimplifyError, calculateBalances, resolveSplit, simplifyDebts } from 'debt-simplify';
import { describe, expect, it } from 'vitest';

// These cover the library placeholder's own arithmetic. When the published
// `debt-simplify` replaces it, this file is what proves the swap did not
// change behavior.
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
