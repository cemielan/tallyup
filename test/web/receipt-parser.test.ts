import { describe, expect, it } from 'vitest';
import { parseReceipt } from '../../web/src/lib/receipt-parser';

// OCR output as it actually arrives: headers, addresses, dates, noise.
const WARUNG = `
WARUNG MAKAN SEDERHANA
Jl. Kebon Jeruk No. 27, Jakarta
Telp 021-5551234
05/10/2026 19:42   Meja 12
Kasir: Dewi
--------------------------------
2 Nasi Goreng Spesial      70.000
Sate Ayam x2               50.000
Es Teh Manis 3 x 5.000     15.000
Kerupuk                     3.5OO
--------------------------------
Subtotal                  138.500
Service 5%                  6.925
PB1 10%                    14.543
Diskon Member              -5.000
TOTAL                     154.968
Tunai                     200.000
Kembali                    45.032
Terima kasih
`;

describe('parseReceipt', () => {
  const parsed = parseReceipt(WARUNG);

  it('reads items with quantities and unit prices', () => {
    expect(parsed.items).toEqual([
      { name: 'Nasi Goreng Spesial', price: 35_000, qty: 2 },
      { name: 'Sate Ayam', price: 25_000, qty: 2 },
      { name: 'Es Teh Manis', price: 5_000, qty: 3 },
      { name: 'Kerupuk', price: 3_500, qty: 1 },
    ]);
  });

  it('separates tax, service and discount from items', () => {
    expect(parsed).toMatchObject({ tax: 14_543, service: 6_925, discount: 5_000, total: 154_968 });
  });

  it('ignores payment, change, dates, phone numbers and the subtotal', () => {
    const names = parsed.items.map((i) => i.name.toLowerCase()).join(' ');
    expect(names).not.toMatch(/tunai|kembali|subtotal|telp|meja/);
  });

  it('keeps a line total when the quantity does not divide it', () => {
    expect(parseReceipt('3 Kopi Susu   20.000').items).toEqual([
      { name: '3x Kopi Susu', price: 20_000, qty: 1 },
    ]);
  });

  it('accepts comma thousands and a ,00 tail', () => {
    expect(parseReceipt('Mie Ayam Rp 25,000\nBakso 30.000,00').items).toEqual([
      { name: 'Mie Ayam', price: 25_000, qty: 1 },
      { name: 'Bakso', price: 30_000, qty: 1 },
    ]);
  });

  it('returns nothing rather than garbage for text with no prices', () => {
    expect(parseReceipt('hello\nworld')).toEqual({ items: [], tax: 0, service: 0, discount: 0 });
  });
});
