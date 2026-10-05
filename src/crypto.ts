/**
 * The server's only cryptography: minting random identifiers and hashing
 * edit tokens. Event data is encrypted and decrypted in the browser; this
 * Worker never holds a key that could read it (docs/05-SECURITY.md §2).
 */

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `bytes` random bytes, base64url without padding. */
export function randomToken(bytes: number): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A share id: 128 bits, 22 characters. */
export const newShareId = (): string => randomToken(16);

/** An edit token: 256 bits, 43 characters. Shown to the host exactly once. */
export const newEditToken = (): string => randomToken(32);

/**
 * SHA-256 of an opaque token. Fast hashing is correct here: this compares a
 * 256-bit random value, not a guessable password, so there is nothing for a
 * slow hash to protect against.
 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
