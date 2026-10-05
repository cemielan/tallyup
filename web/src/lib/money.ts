const format = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });

/** 35000 -> "35.000" */
export const rupiah = (amount: number): string => format.format(amount);

/** 35000 -> "Rp 35.000" */
export const rp = (amount: number): string => `Rp ${rupiah(amount)}`;

/**
 * Whatever a person typed -> whole rupiah. Separators are noise: "35.000",
 * "35,000" and "35000" are the same amount, because IDR has no decimals
 * worth entering.
 */
export function parseRupiah(input: string): number {
  const digits = input.replace(/\D/g, '');
  return digits ? Number(digits.slice(0, 12)) : 0;
}
