import { calculateBalances, resolveSplit, simplifyDebts } from 'debt-simplify';
import type { Balances, ExpenseInput, Transfer } from 'debt-simplify';
import { LIMITS, type Bill, type EventDoc } from './doc';

/**
 * All money math for an event. Every rupiah is allocated by `debt-simplify`
 * (FR-501); this module only decides what to hand it.
 */

export interface BillBreakdown {
  bill: Bill;
  subtotal: number;
  total: number;
  /** What each person owes for this bill, tax and service included. Sums to `total`. */
  shares: Record<string, number>;
  error?: string;
}

export function lineTotal(item: { price: number; qty: number }): number {
  return item.price * item.qty;
}

export function breakdownBill(bill: Bill, everyone: string[]): BillBreakdown {
  const subtotals: Record<string, number> = {};
  let subtotal = 0;

  for (const item of bill.items) {
    const line = lineTotal(item);
    if (line === 0) continue;
    const who = item.for.length > 0 ? item.for : everyone;
    // Shared items split equally, with any leftover rupiah placed by the library.
    const parts = resolveSplit(line, { type: 'equal', participants: [...new Set(who)] });
    for (const [person, amount] of Object.entries(parts)) {
      subtotals[person] = (subtotals[person] ?? 0) + amount;
    }
    subtotal += line;
  }

  const total = subtotal + bill.tax + bill.service - bill.discount;
  const fail = (error: string): BillBreakdown => ({ bill, subtotal, total, shares: {}, error });

  if (subtotal === 0) return fail(total > 0 ? 'Add items before tax or service' : 'No items yet');
  if (total <= 0) return fail('Discount is larger than the bill');
  if (subtotal > LIMITS.amount || total > LIMITS.amount) return fail('Bill is over Rp 50.000.000');

  // Tax, service and discount follow consumption: whoever ordered more pays
  // more of them. One proportional split over the whole bill does that and
  // still lands on the exact total.
  return { bill, subtotal, total, shares: resolveSplit(total, { type: 'shares', shares: subtotals }) };
}

export interface Summary {
  bills: BillBreakdown[];
  grandTotal: number;
  /** What each person consumed across every bill. */
  consumed: Record<string, number>;
  /** Net position after payments. Positive = is owed, negative = owes. */
  balances: Balances;
  /** The fewest payments that settle what is still open. */
  transfers: Transfer[];
  settled: boolean;
}

export function summarize(doc: EventDoc): Summary {
  const everyone = doc.people.map((p) => p.id);
  const bills = doc.bills.map((bill) => breakdownBill(bill, everyone));
  const valid = bills.filter((b) => !b.error);

  const consumed: Record<string, number> = {};
  for (const b of valid) {
    for (const [person, amount] of Object.entries(b.shares)) {
      consumed[person] = (consumed[person] ?? 0) + amount;
    }
  }

  const expenses: ExpenseInput[] = valid.map((b) => ({
    paidBy: b.bill.paidBy,
    amount: b.total,
    split: { type: 'exact', amounts: b.shares },
  }));
  // A confirmed payment is replayed as an expense the payer covered entirely
  // for the recipient, which moves both balances toward zero by exactly that
  // amount. The library stays the only thing that nets anything.
  for (const s of doc.settlements) {
    expenses.push({ paidBy: s.from, amount: s.amount, split: { type: 'exact', amounts: { [s.to]: s.amount } } });
  }

  const balances = calculateBalances(expenses);
  const transfers = simplifyDebts(balances);
  const grandTotal = valid.reduce((sum, b) => sum + b.total, 0);

  return { bills, grandTotal, consumed, balances, transfers, settled: grandTotal > 0 && transfers.length === 0 };
}
