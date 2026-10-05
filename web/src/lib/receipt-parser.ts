import { LIMITS } from './doc';

/**
 * Turn OCR text from a receipt into items and charges.
 *
 * Heuristic, and honest about it: receipts have no standard layout, and OCR
 * misreads faded thermal print. The output is a starting point the host
 * reviews and corrects in the bill editor, never a final answer. `total`
 * is returned when the receipt prints one, so the editor can warn when the
 * parsed items do not add up to it.
 *
 * Tuned for Indonesian receipts: "35.000" / "35,000" thousands separators,
 * an optional ",00" tail, and Indonesian labels for tax, service and
 * discount alongside the English ones.
 */

export interface ParsedItem {
  name: string;
  price: number;
  qty: number;
}

export interface ParsedReceipt {
  items: ParsedItem[];
  tax: number;
  service: number;
  discount: number;
  total?: number;
}

// A price at the end of a line, preceded by whitespace or a colon so a date
// ("05/10/2026") or a time ("14:32") does not pass for one.
const PRICE_AT_END =
  /(?:^|[\s:])[-(]?\s*(?:rp\.?\s*)?(\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d{2})?\)?\s*-?$/i;

const SUBTOTAL = /\bsub\s*-?\s*total\b/;
const TOTAL = /\b(grand\s*total|total|jumlah|tagihan|amount due)\b/;
const TAX = /\b(tax|pajak|ppn|pb1|pbi|vat)\b/;
const SERVICE = /\b(service|servis|svc|s\/c|sc)\b/;
const DISCOUNT = /\b(disc|discount|diskon|potongan|promo|voucher)\b/;
// Lines that carry a number but are not something anyone ate.
const IGNORE =
  /\b(cash|tunai|change|kembali|kembalian|debit|credit|kredit|card|kartu|qris|bayar|payment|pembayaran|edc|rounding|pembulatan|meja|table|kasir|cashier|tgl|tanggal|date|jam|time|telp|tel|phone|npwp|order|struk|receipt|invoice|pax|guest|tamu)\b/;

/** OCR often reads a 0 as O inside a price: "35.0O0". Only the last token is touched. */
const fixDigits = (line: string) =>
  line.replace(/(\S+)$/, (token) => (/^[\doO.,]*\d[\doO.,]*$/.test(token) ? token.replace(/[oO]/g, '0') : token));

function parseAmount(token: string): number {
  return Number(token.replace(/[.,]/g, ''));
}

function splitQty(label: string): { name: string; qty: number } {
  // "Es Teh 2 x 5.000", "Es Teh 2 @5.000"
  let m = label.match(/^(.*?)\s*(\d{1,2})\s*[x×@]\s*[\d.,]+$/i);
  if (m) return { name: m[1], qty: Number(m[2]) };
  // "2x Es Teh", "2 Es Teh"
  m = label.match(/^(\d{1,2})\s*[x×]?\s+(.+)$/i);
  if (m) return { name: m[2], qty: Number(m[1]) };
  // "Es Teh x2"
  m = label.match(/^(.+?)\s+[x×]\s*(\d{1,2})$/i);
  if (m) return { name: m[1], qty: Number(m[2]) };
  return { name: label, qty: 1 };
}

export function parseReceipt(text: string): ParsedReceipt {
  const out: ParsedReceipt = { items: [], tax: 0, service: 0, discount: 0 };

  for (const raw of text.split(/\r?\n/)) {
    const line = fixDigits(raw.trim());
    const match = line.match(PRICE_AT_END);
    if (!match || match.index === undefined) continue;

    const amount = parseAmount(match[1]);
    // Rupiah prices below Rp 100 do not exist in practice; above the cap is
    // a phone number or an invoice id, not a price.
    if (amount < 100 || amount > LIMITS.amount) continue;

    const label = line.slice(0, match.index).replace(/[.:\s]+$/, '').trim();
    const lower = label.toLowerCase();
    if ((lower.match(/[a-z]/g)?.length ?? 0) < 2) continue;

    if (SUBTOTAL.test(lower)) continue;
    if (TAX.test(lower)) {
      out.tax += amount;
      continue;
    }
    if (SERVICE.test(lower)) {
      out.service += amount;
      continue;
    }
    if (DISCOUNT.test(lower)) {
      out.discount += amount;
      continue;
    }
    if (TOTAL.test(lower)) {
      // The first total ends the item list; what follows is payment and change.
      out.total ??= amount;
      continue;
    }
    if (IGNORE.test(lower) || out.total !== undefined) continue;

    const { name, qty } = splitQty(label);
    // Receipts print the line total. Keep a unit price only when it divides
    // evenly; otherwise one line at the printed amount loses nothing.
    if (qty > 1 && amount % qty === 0) {
      out.items.push({ name: name.trim(), price: amount / qty, qty });
    } else {
      out.items.push({ name: (qty > 1 ? `${qty}x ${name}` : name).trim(), price: amount, qty: 1 });
    }
    if (out.items.length >= LIMITS.items) break;
  }

  return out;
}
