import { describe, expect, it } from 'vitest';
import { MAX_SHARE_CIPHERTEXT } from '../../src/validation';
import { fromBase64Url, newKey, open, seal, toBase64Url } from '../../web/src/lib/crypto';
import { LIMITS, newBill, newDoc, parseDoc, type EventDoc } from '../../web/src/lib/doc';
import { parseRoute } from '../../web/src/lib/links';
import { parseRupiah } from '../../web/src/lib/money';
import { breakdownBill, summarize } from '../../web/src/lib/split';

function dinner(): EventDoc {
  const doc = newDoc('Ana');
  doc.title = 'Dinner';
  doc.people.push({ id: 'budi', name: 'Budi' }, { id: 'cici', name: 'Cici' });
  const ana = doc.people[0].id;
  const bill = newBill(ana, 1);
  bill.items = [
    { name: 'Nasi Goreng', price: 30_000, qty: 1, for: [ana] },
    { name: 'Sate', price: 60_000, qty: 1, for: ['budi'] },
    { name: 'Es Teh', price: 5_000, qty: 3, for: [] }, // everyone
  ];
  doc.bills.push(bill);
  return doc;
}

const sum = (values: Record<string, number>) => Object.values(values).reduce((a, b) => a + b, 0);

describe('breakdownBill', () => {
  it('charges each item to the people who had it', () => {
    const doc = dinner();
    const { shares, total } = breakdownBill(doc.bills[0], doc.people.map((p) => p.id));
    expect(total).toBe(105_000);
    expect(shares).toEqual({ [doc.people[0].id]: 35_000, budi: 65_000, cici: 5_000 });
  });

  it('spreads tax, service and discount in proportion to consumption, to the exact rupiah', () => {
    const doc = dinner();
    Object.assign(doc.bills[0], { tax: 10_500, service: 5_250, discount: 7_777 });
    const { shares, total } = breakdownBill(doc.bills[0], doc.people.map((p) => p.id));
    expect(total).toBe(105_000 + 10_500 + 5_250 - 7_777);
    expect(sum(shares)).toBe(total);
    // Budi ordered most, so Budi carries most of the charges.
    expect(shares.budi).toBeGreaterThan(shares[doc.people[0].id]);
  });

  it('splits a shared item without losing a rupiah', () => {
    const doc = dinner();
    doc.bills[0].items = [{ name: 'Pizza', price: 100_000, qty: 1, for: [] }];
    const { shares } = breakdownBill(doc.bills[0], doc.people.map((p) => p.id));
    expect(sum(shares)).toBe(100_000);
    expect(Object.values(shares).sort()).toEqual([33_333, 33_333, 33_334]);
  });

  it('flags a discount bigger than the bill instead of producing negative debt', () => {
    const doc = dinner();
    doc.bills[0].discount = 1_000_000;
    expect(breakdownBill(doc.bills[0], ['x']).error).toMatch(/Discount/);
  });

  it('flags charges with no items to weigh them by', () => {
    const doc = dinner();
    doc.bills[0].items = [];
    doc.bills[0].tax = 1_000;
    expect(breakdownBill(doc.bills[0], ['x']).error).toBeDefined();
  });
});

describe('summarize', () => {
  it('turns one payer into debts from everyone else', () => {
    const doc = dinner();
    const ana = doc.people[0].id;
    const summary = summarize(doc);
    expect(summary.grandTotal).toBe(105_000);
    expect(summary.transfers).toEqual(
      expect.arrayContaining([
        { from: 'budi', to: ana, amount: 65_000 },
        { from: 'cici', to: ana, amount: 5_000 },
      ]),
    );
    expect(summary.settled).toBe(false);
  });

  it('nets several payers into the fewest transfers', () => {
    const doc = dinner();
    const taxi = newBill('budi', 2);
    taxi.items = [{ name: 'Taxi', price: 90_000, qty: 1, for: [] }];
    doc.bills.push(taxi);
    const { transfers, balances } = summarize(doc);
    expect(sum(balances)).toBe(0);
    expect(transfers.length).toBeLessThanOrEqual(2);
  });

  it('confirmed payments close the debt they pay', () => {
    const doc = dinner();
    const ana = doc.people[0].id;
    doc.settlements.push(
      { id: 's1', from: 'budi', to: ana, amount: 65_000, at: 1 },
      { id: 's2', from: 'cici', to: ana, amount: 5_000, at: 2 },
    );
    const summary = summarize(doc);
    expect(summary.transfers).toEqual([]);
    expect(summary.settled).toBe(true);
    // What people consumed is unchanged by paying for it.
    expect(summary.consumed.budi).toBe(65_000);
  });

  it('a partial payment leaves the remainder open', () => {
    const doc = dinner();
    doc.settlements.push({ id: 's1', from: 'budi', to: doc.people[0].id, amount: 15_000, at: 1 });
    expect(summarize(doc).transfers).toContainEqual({ from: 'budi', to: doc.people[0].id, amount: 50_000 });
  });
});

describe('parseDoc', () => {
  it('accepts a valid document', () => {
    const doc = dinner();
    expect(parseDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  it('rejects a reference to someone who is not in the event', () => {
    const doc = dinner();
    doc.bills[0].paidBy = 'ghost';
    expect(() => parseDoc(doc)).toThrow(/Unknown person/);
  });

  it('rejects unknown fields, so a crafted link cannot smuggle data in', () => {
    expect(() => parseDoc({ ...dinner(), script: '<img onerror>' })).toThrow();
  });

  it('rejects a non-numeric account number', () => {
    const doc = dinner();
    doc.people[0].payment = { bankName: 'BCA', accountNumber: '12-34' };
    expect(() => parseDoc(doc)).toThrow();
  });
});

describe('encryption', () => {
  it('uses the same ciphertext cap as the server', () => {
    expect(LIMITS.ciphertext).toBe(MAX_SHARE_CIPHERTEXT);
  });

  it('compresses, so the largest legal event still fits the cap', async () => {
    const doc = dinner();
    for (let i = doc.people.length; i < LIMITS.people; i += 1) doc.people.push({ id: `p${i}`, name: `Person ${i}` });
    const ids = doc.people.map((p) => p.id);
    doc.bills = Array.from({ length: LIMITS.bills }, (_, b) => ({
      ...newBill(ids[0], b + 1),
      items: Array.from({ length: LIMITS.items }, (_, i) => ({
        name: `Item number ${i} with a longish name`,
        price: 12_345,
        qty: 2,
        for: ids.slice(0, (i % 8) + 1),
      })),
    }));
    const sealed = await seal(newKey(), doc);
    expect(JSON.stringify(doc).length).toBeGreaterThan(LIMITS.ciphertext);
    expect(sealed.ciphertext.length).toBeLessThan(LIMITS.ciphertext);
  });

  it('still opens plain, uncompressed JSON from third-party clients', async () => {
    const key = newKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const raw = await crypto.subtle.importKey('raw', fromBase64Url(key), 'AES-GCM', false, ['encrypt']);
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, raw, new TextEncoder().encode('{"hello":1}'));
    expect(await open(key, { ciphertext: toBase64Url(new Uint8Array(data)), iv: toBase64Url(iv) })).toEqual({ hello: 1 });
  });

  it('round-trips a document', async () => {
    const key = newKey();
    const doc = dinner();
    expect(await open(key, await seal(key, doc))).toEqual(doc);
  });

  it('uses a fresh IV every time', async () => {
    const key = newKey();
    const [a, b] = await Promise.all([seal(key, 1), seal(key, 1)]);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('refuses the wrong key and tampered ciphertext', async () => {
    const sealed = await seal(newKey(), dinner());
    await expect(open(newKey(), sealed)).rejects.toThrow();
    const key = newKey();
    const good = await seal(key, dinner());
    const flipped = (good.ciphertext[0] === 'A' ? 'B' : 'A') + good.ciphertext.slice(1);
    await expect(open(key, { ...good, ciphertext: flipped })).rejects.toThrow();
  });
});

describe('parseRoute', () => {
  const id = 'A'.repeat(22);
  const key = 'k'.repeat(43);
  const token = 't'.repeat(43);

  it('recognises each route', () => {
    expect(parseRoute('#/new')).toEqual({ name: 'new' });
    expect(parseRoute(`#/s/${id}/${key}`)).toEqual({ name: 'view', id, key });
    expect(parseRoute(`#/e/${id}/${key}/${token}`)).toEqual({ name: 'import', id, key, token });
    expect(parseRoute(`#/h/${id}`)).toEqual({ name: 'host', id });
  });

  it('sends anything malformed home', () => {
    expect(parseRoute(`#/s/${id}/short`)).toEqual({ name: 'home' });
    expect(parseRoute('#/whatever')).toEqual({ name: 'home' });
    expect(parseRoute('')).toEqual({ name: 'home' });
  });
});

describe('parseRupiah', () => {
  it('treats separators as noise', () => {
    expect(parseRupiah('35.000')).toBe(35_000);
    expect(parseRupiah('Rp 35,000')).toBe(35_000);
    expect(parseRupiah('')).toBe(0);
  });
});
