import { z } from 'zod';
import { ApiError } from './errors';

/**
 * Every body and path parameter is validated here before it reaches a
 * handler, and unknown fields are rejected rather than dropped
 * (docs/05-SECURITY.md §4).
 *
 * The server cannot validate what it cannot read: event content is
 * ciphertext. What it can enforce is shape and size, which is what bounds
 * storage and CPU per request. Content validation happens in the browser,
 * after decryption.
 */

/**
 * Ciphertext ceilings, in base64url characters. An event for a 30-person
 * dinner with ten bills of sixty items encrypts to well under this; the cap
 * exists so one share cannot eat the storage of thousands.
 */
export const MAX_SHARE_CIPHERTEXT = 48_000;
export const MAX_CLAIM_CIPHERTEXT = 2_000;

/** Pending claims per share. A host confirms or declines them; more than this is spam. */
export const MAX_CLAIMS_PER_SHARE = 50;

const base64url = /^[A-Za-z0-9_-]+$/;

export const shareIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/, 'Invalid share id');
export const claimIdSchema = shareIdSchema;

// AES-GCM's 96-bit nonce, base64url without padding.
const ivSchema = z.string().regex(/^[A-Za-z0-9_-]{16}$/, 'iv must be 12 bytes, base64url');

const ciphertext = (max: number) =>
  z
    .string()
    .min(1)
    .max(max, `ciphertext must be at most ${max} characters`)
    .regex(base64url, 'ciphertext must be base64url');

export const createShareSchema = z.strictObject({
  ciphertext: ciphertext(MAX_SHARE_CIPHERTEXT),
  iv: ivSchema,
});

export const updateShareSchema = z.strictObject({
  ciphertext: ciphertext(MAX_SHARE_CIPHERTEXT),
  iv: ivSchema,
  /** The version the caller last read. A mismatch is a 409, not a silent overwrite. */
  version: z.number().int().positive(),
});

/** Turnstile tokens are at most 2,048 characters. */
export const passRequestSchema = z.strictObject({ token: z.string().min(1).max(2048) });

export const createClaimSchema = z.strictObject({
  ciphertext: ciphertext(MAX_CLAIM_CIPHERTEXT),
  iv: ivSchema,
});

/**
 * Turn a Zod failure into the API's single error envelope. The first issue
 * drives the message, and every issue lands in `details` so a client can
 * highlight more than one field at a time.
 */
function toApiError(error: z.ZodError): ApiError {
  const [first] = error.issues;
  const path = first?.path.join('.');
  return new ApiError('VALIDATION_ERROR', first ? first.message : 'Request failed validation', {
    details: {
      ...(path ? { field: path } : {}),
      issues: error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    },
  });
}

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw toApiError(result.error);
  return result.data;
}

/** Parse a JSON body, treating an unparseable body as a validation error. */
export async function parseBody<T extends z.ZodType>(
  c: { req: { json: () => Promise<unknown> } },
  schema: T,
): Promise<z.output<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError('VALIDATION_ERROR', 'Request body must be valid JSON');
  }
  return parse(schema, raw);
}
