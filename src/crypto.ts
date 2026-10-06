/**
 * The server's cryptography: random identifiers, edit-token hashes and
 * client passes. Event data is encrypted and decrypted in the browser; this
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

/**
 * Client passes (docs/05-SECURITY.md §3): `<id>.<expiresAt>.<hmac>`, signed
 * with PASS_SECRET. Stateless on purpose. Issuing or checking one costs no
 * D1 write, and the daily write budget is the tightest limit this app has.
 */
const PASS_PATTERN = /^([A-Za-z0-9_-]{22})\.(\d{13})\.([A-Za-z0-9_-]{43})$/;

function hmacKey(secret: string, usage: 'sign' | 'verify') {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export async function signPass(secret: string, expiresAt: number): Promise<string> {
  const body = `${randomToken(16)}.${expiresAt}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(sig))}`;
}

/** The pass id if the pass is authentic and unexpired, otherwise undefined. */
export async function verifyPass(secret: string, pass: string, now = Date.now()): Promise<string | undefined> {
  const match = PASS_PATTERN.exec(pass);
  if (!match || Number(match[2]) <= now) return undefined;
  const sig = Uint8Array.from(atob(match[3].replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
  // `verify` compares in constant time, unlike comparing two strings.
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), sig, encoder.encode(`${match[1]}.${match[2]}`));
  return ok ? match[1] : undefined;
}
