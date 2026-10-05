import { z } from 'zod';

/**
 * The event document: everything about a split, encrypted as one blob.
 * The server never sees this shape -- only its ciphertext -- so this schema
 * is the real validation boundary. Anything decrypted from a link is
 * untrusted input until it has passed `parseDoc`.
 *
 * Money is whole rupiah. IDR has no coins in circulation below Rp 100, so
 * there is no minor unit worth modelling.
 */

export const LIMITS = {
  people: 30,
  bills: 10,
  items: 60,
  settlements: 200,
  name: 40,
  title: 80,
  itemName: 80,
  qty: 99,
  /**
   * ponytail: per-bill ceiling of Rp 50 juta. The library's proportional
   * split multiplies total by weight in floating point, which stays exact
   * only while that product is under 2^53. This cap keeps it there; lift it
   * by moving the library's `distribute` to BigInt.
   */
  amount: 50_000_000,
  /** Must equal MAX_SHARE_CIPHERTEXT in src/validation.ts; test/web/split.test.ts checks. */
  ciphertext: 48_000,
} as const;

const id = z.string().regex(/^[A-Za-z0-9_-]{1,24}$/);
const money = z.number().int().min(0).max(LIMITS.amount);

export const paymentSchema = z.strictObject({
  bankName: z.string().trim().min(1, 'Enter a bank name').max(40),
  accountNumber: z.string().regex(/^\d{4,24}$/, 'Account number must be digits only'),
  accountHolder: z.string().trim().max(60).optional(),
});

export const personSchema = z.strictObject({
  id,
  name: z.string().trim().min(1, 'Every person needs a name').max(LIMITS.name),
  payment: paymentSchema.optional(),
});

export const itemSchema = z.strictObject({
  name: z.string().trim().max(LIMITS.itemName),
  /** Unit price. */
  price: money,
  qty: z.number().int().min(1).max(LIMITS.qty),
  /** Who shares this item. Empty means everyone. */
  for: z.array(id).max(LIMITS.people),
});

export const billSchema = z.strictObject({
  id,
  name: z.string().trim().min(1).max(60),
  paidBy: id,
  items: z.array(itemSchema).max(LIMITS.items),
  // As printed on the receipt, spread across people in proportion to what they ordered.
  tax: money,
  service: money,
  discount: money,
});

export const settlementSchema = z.strictObject({
  id,
  from: id,
  to: id,
  amount: money.positive(),
  at: z.number().int().nonnegative(),
});

export const docSchema = z
  .strictObject({
    v: z.literal(1),
    title: z.string().trim().min(1).max(LIMITS.title),
    currency: z.literal('IDR'),
    createdAt: z.number().int().nonnegative(),
    people: z.array(personSchema).min(1).max(LIMITS.people),
    bills: z.array(billSchema).max(LIMITS.bills),
    settlements: z.array(settlementSchema).max(LIMITS.settlements),
  })
  .superRefine((doc, ctx) => {
    // Every reference must point at a real person, or the balance math would
    // credit and debit someone nobody can see.
    const ids = new Set(doc.people.map((p) => p.id));
    if (ids.size !== doc.people.length) ctx.addIssue({ code: 'custom', message: 'Duplicate person id' });
    const known = (ref: string, path: (string | number)[]) => {
      if (!ids.has(ref)) ctx.addIssue({ code: 'custom', message: `Unknown person ${ref}`, path });
    };
    doc.bills.forEach((bill, b) => {
      known(bill.paidBy, ['bills', b, 'paidBy']);
      bill.items.forEach((item, i) => item.for.forEach((ref) => known(ref, ['bills', b, 'items', i])));
    });
    doc.settlements.forEach((s, i) => {
      known(s.from, ['settlements', i, 'from']);
      known(s.to, ['settlements', i, 'to']);
      if (s.from === s.to) ctx.addIssue({ code: 'custom', message: 'Self-payment', path: ['settlements', i] });
    });
  });

/** A viewer's "I paid", encrypted with the event key and stored beside it. */
export const claimSchema = z.strictObject({
  from: id,
  to: id,
  amount: money.positive(),
  at: z.number().int().nonnegative(),
});

export type Payment = z.infer<typeof paymentSchema>;
export type Person = z.infer<typeof personSchema>;
export type Item = z.infer<typeof itemSchema>;
export type Bill = z.infer<typeof billSchema>;
export type Settlement = z.infer<typeof settlementSchema>;
export type EventDoc = z.infer<typeof docSchema>;
export type Claim = z.infer<typeof claimSchema>;

export function parseDoc(value: unknown): EventDoc {
  return docSchema.parse(value);
}

/** The first validation problem, phrased for a person: "Enter a bank name (people #2 › payment)". */
export function problemOf(error: unknown): string {
  if (!(error instanceof z.ZodError)) return error instanceof Error ? error.message : 'Invalid event';
  const issue = error.issues[0];
  const where = issue.path.map((part) => (typeof part === 'number' ? `#${part + 1}` : String(part))).join(' › ');
  return where ? `${issue.message} (${where})` : issue.message;
}

/** Short random id for people, bills and settlements inside a document. */
export function localId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}

export function newDoc(hostName = 'Me'): EventDoc {
  return {
    v: 1,
    title: '',
    currency: 'IDR',
    createdAt: Date.now(),
    people: [{ id: localId(), name: hostName }],
    bills: [],
    settlements: [],
  };
}

export function newBill(paidBy: string, n: number): Bill {
  return { id: localId(), name: `Bill ${n}`, paidBy, items: [], tax: 0, service: 0, discount: 0 };
}
