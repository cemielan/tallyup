/**
 * End-to-end encryption for events (docs/05-SECURITY.md §2).
 *
 * AES-256-GCM via WebCrypto. The key is 32 random bytes that live only in
 * the share link's `#fragment`, which browsers never send to a server. The
 * server stores `{ ciphertext, iv }` and cannot read either.
 *
 * Plaintext is gzipped before encryption. Event JSON is repetitive (the same
 * person ids on every item), so this shrinks it several times over, which is
 * what lets the free 500 MB database hold that many more events
 * (docs/02-ARCHITECTURE.md §3).
 */

export interface Sealed {
  ciphertext: string;
  iv: string;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A fresh 256-bit key, base64url (43 characters). */
export function newKey(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function importKey(key: string): Promise<CryptoKey> {
  if (!KEY_PATTERN.test(key)) throw new Error('Malformed key');
  return crypto.subtle.importKey('raw', fromBase64Url(key), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function pipe(bytes: Uint8Array<ArrayBuffer>, through: CompressionStream | DecompressionStream) {
  const stream = new Blob([bytes]).stream().pipeThrough(through);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function seal(key: string, value: unknown): Promise<Sealed> {
  // A fresh 96-bit nonce per encryption. Reusing one under the same key
  // breaks GCM outright, so it is never derived from anything.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = await pipe(encoder.encode(JSON.stringify(value)), new CompressionStream('gzip'));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importKey(key), plain);
  return { ciphertext: toBase64Url(new Uint8Array(data)), iv: toBase64Url(iv) };
}

/**
 * Decrypt and parse. Throws on a wrong key or tampered ciphertext (GCM
 * authenticates). Accepts gzipped or plain JSON, as docs/04-API-SPEC.md §1
 * allows either: gzip always starts 1f 8b, and JSON never does.
 */
export async function open(key: string, sealed: Sealed): Promise<unknown> {
  let bytes = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(sealed.iv) },
      await importKey(key),
      fromBase64Url(sealed.ciphertext),
    ),
  );
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await pipe(bytes, new DecompressionStream('gzip'));
  return JSON.parse(decoder.decode(bytes));
}
