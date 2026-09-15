/**
 * All cryptography here goes through WebCrypto (`crypto.subtle`), which is
 * native to the Workers runtime. Native Node addons such as the usual
 * `argon2` build do not run in a Worker isolate (docs/05-SECURITY.md §2).
 */

/**
 * PBKDF2 iteration count for new password hashes.
 *
 * BENCHMARKED, NOT GUESSED. Measured inside the Workers runtime by
 * `test/cpu-budget.test.ts`, which fails if this value stops fitting the
 * budget:
 *
 *     4,000 iterations   3.5 ms       100,000 iterations   62.8 ms
 *     6,000 iterations   4.6 ms       200,000 iterations  126.0 ms
 *    10,000 iterations   8.0 ms
 *
 * The Workers Free plan allows 10 ms of CPU per request and, unlike the
 * Paid plan, does not let that be raised (`limits.cpu_ms` is Paid-only).
 * Hashing is the dominant cost of a login, so 4,000 leaves roughly 6 ms for
 * everything else and survives edge hardware being slower than a dev laptop.
 *
 * BE CLEAR ABOUT WHAT THIS BUYS: 4,000 iterations is far below current OWASP
 * guidance for PBKDF2-SHA256 (600,000). It is not a judgement that weaker
 * hashing is acceptable -- it is the most this platform tier can afford, and
 * a password database stolen from this deployment would be meaningfully
 * cheaper to crack than one from a conventionally-hosted app.
 *
 * The fix is a plan change, not a code change (docs/02-ARCHITECTURE.md
 * "Upgrade triggers"): Workers Paid is $5/month, makes `limits.cpu_ms`
 * configurable, and puts 600,000 iterations comfortably in reach. Because
 * every stored hash carries the count it was made with, raising this value
 * is backward compatible -- existing users keep verifying at their old cost
 * and upgrade on their next password write.
 */
export const DEFAULT_PBKDF2_ITERATIONS = 4_000;

const PBKDF2_HASH = 'SHA-256';
const SALT_BYTES = 16;
const DERIVED_BITS = 256;
const HASH_PREFIX = 'pbkdf2-sha256';

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Comparison whose duration does not depend on where the first difference is. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function deriveBits(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: PBKDF2_HASH, salt: salt as BufferSource, iterations },
    key,
    DERIVED_BITS,
  );
  return new Uint8Array(bits);
}

/**
 * Hash a password for storage. The iteration count is embedded in the stored
 * string, so it can be raised later without invalidating existing hashes --
 * old records keep verifying with their own count until the next password
 * write. Benchmark the count against the platform CPU budget before raising
 * it (docs/02-ARCHITECTURE.md §3).
 */
export async function hashPassword(password: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await deriveBits(password, salt, iterations);
  return `${HASH_PREFIX}$${iterations}$${toBase64(salt)}$${toBase64(derived)}`;
}

/**
 * Verify a password against a stored hash. Returns false rather than
 * throwing on a malformed stored hash, so a corrupt row cannot be told
 * apart from a wrong password by the caller.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== HASH_PREFIX) return false;

  const iterations = Number.parseInt(parts[1], 10);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;

  try {
    const salt = fromBase64(parts[2]);
    const expected = fromBase64(parts[3]);
    const derived = await deriveBits(password, salt, iterations);
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Spend roughly the same CPU as a real verification when no user matched, so
 * "no such email" and "wrong password" are indistinguishable by response
 * time as well as by message (docs/05-SECURITY.md §2).
 */
export async function dummyVerify(iterations: number): Promise<void> {
  await deriveBits('placeholder', new Uint8Array(SALT_BYTES), iterations);
}

/** A high-entropy opaque token, URL-safe. 32 bytes = 256 bits. */
export function generateOpaqueToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * SHA-256 of an opaque token. Fast hashing is correct here: this is a
 * comparison of a 256-bit random value, not of a guessable password, so
 * there is nothing for a slow hash to protect against.
 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Crockford base32 without I, L, O, U -- no character pairs a human can
// confuse when retyping an invite code from a screenshot or a chat message.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * An invite code is effectively a password for joining a group, so it needs
 * real entropy (docs/05-SECURITY.md §1). 16 characters over a 32-symbol
 * alphabet is 80 bits, grouped for legibility: `A1B2-C3D4-E5F6-G7H8`.
 */
export function generateInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

export const newId = (): string => crypto.randomUUID();
