import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JS with JSDoc types, checked by web/tsconfig.json
import { currencyDigits, estimateShares, formatMoney, initials, toMajorString, toMinorUnits } from '../../web/js/ui.js';

/**
 * The client's money path.
 *
 * The API speaks integer minor units and never decimals, so every amount a
 * person types has to cross that boundary exactly. Getting it wrong by one
 * unit is the kind of bug nobody notices until a balance refuses to settle.
 */

describe('toMinorUnits', () => {
  it('converts decimal input for a two-decimal currency', () => {
    expect(toMinorUnits('10.50', 'USD')).toBe(1050);
    expect(toMinorUnits('10.5', 'USD')).toBe(1050);
    expect(toMinorUnits('10', 'USD')).toBe(1000);
    expect(toMinorUnits('0.07', 'USD')).toBe(7);
    expect(toMinorUnits('120.00', 'USD')).toBe(12000);
  });

  it('survives the float traps that catch naive multiplication', () => {
    // Every one of these is wrong if computed as Math.round(value * 100).
    expect(toMinorUnits('0.29', 'USD')).toBe(29);
    expect(toMinorUnits('8.11', 'USD')).toBe(811);
    expect(toMinorUnits('1.005', 'USD')).toBeNaN(); // more precision than USD has
    expect(toMinorUnits('10.075', 'USD')).toBeNaN();
  });

  it('accepts thousands separators and surrounding space', () => {
    expect(toMinorUnits('1,234.56', 'USD')).toBe(123456);
    expect(toMinorUnits(' 99.99 ', 'USD')).toBe(9999);
  });

  it('respects currencies with no minor unit', () => {
    expect(currencyDigits('JPY')).toBe(0);
    expect(toMinorUnits('500', 'JPY')).toBe(500);
    expect(toMinorUnits('500.5', 'JPY')).toBeNaN();
  });

  it('rejects anything that is not a positive amount', () => {
    for (const input of ['', '   ', 'abc', '-5', '1e3', '.', '1.2.3']) {
      expect(toMinorUnits(input, 'USD'), `input ${JSON.stringify(input)}`).toBeNaN();
    }
  });

  it('falls back to two decimals for an unknown currency code', () => {
    expect(currencyDigits('XXXNOTREAL')).toBe(2);
  });
});

describe('toMajorString', () => {
  it('round-trips every amount back to the same minor units', () => {
    const cases: Array<[number, string]> = [
      [1050, 'USD'],
      [7, 'USD'],
      [12000, 'USD'],
      [1, 'USD'],
      [999999, 'USD'],
      [500, 'JPY'],
    ];
    for (const [minor, currency] of cases) {
      expect(toMinorUnits(toMajorString(minor, currency), currency), `${minor} ${currency}`).toBe(
        minor,
      );
    }
  });

  it('pads amounts below one major unit', () => {
    expect(toMajorString(7, 'USD')).toBe('0.07');
    expect(toMajorString(70, 'USD')).toBe('0.70');
  });
});

describe('formatMoney', () => {
  it('renders an amount without throwing for a currency Intl does not know', () => {
    expect(formatMoney(1050, 'XXXNOTREAL')).toContain('XXXNOTREAL');
  });
});

describe('estimateShares', () => {
  it('always allocates exactly the total, even when it will not divide', () => {
    const shares = estimateShares(100, [
      ['a', 1],
      ['b', 1],
      ['c', 1],
    ]);
    expect([...shares.values()].reduce((a, b) => a + b, 0)).toBe(100);
    expect([...shares.values()].sort()).toEqual([33, 33, 34]);
  });

  it('weights proportionally', () => {
    const shares = estimateShares(900, [
      ['a', 1],
      ['b', 2],
    ]);
    expect(shares.get('a')).toBe(300);
    expect(shares.get('b')).toBe(600);
  });

  it('is deterministic for the same input', () => {
    const weights: Array<[string, number]> = [
      ['a', 1],
      ['b', 1],
      ['c', 1],
    ];
    expect([...estimateShares(101, weights)]).toEqual([...estimateShares(101, weights)]);
  });

  it('returns nothing rather than dividing by zero', () => {
    expect(estimateShares(100, []).size).toBe(0);
    expect(estimateShares(0, [['a', 1]]).size).toBe(0);
    expect(estimateShares(100, [['a', 0]]).size).toBe(0);
  });

  it('allocates the whole total across many participants', () => {
    const weights: Array<[string, number]> = Array.from({ length: 50 }, (_, i) => [`u${i}`, 1]);
    const shares = estimateShares(100_000, weights);
    expect(shares.size).toBe(50);
    expect([...shares.values()].reduce((a, b) => a + b, 0)).toBe(100_000);
  });
});

describe('initials', () => {
  it('takes at most two, and copes with junk', () => {
    expect(initials('Alice Rivera')).toBe('AR');
    expect(initials('Alice Mary Rivera')).toBe('AM');
    expect(initials('Alice')).toBe('A');
    expect(initials('')).toBe('?');
    expect(initials('   ')).toBe('?');
  });
});
