import { z } from 'zod';
import { ApiError } from './errors';

/**
 * Every body, query and path parameter is validated here before it reaches
 * business logic, and unknown fields are rejected rather than dropped --
 * `z.strictObject` is what closes the mass-assignment hole
 * (docs/05-SECURITY.md §5).
 */

/**
 * Upper bound on a single expense, in minor currency units: 1,000,000,000 =
 * ten million dollars for a two-decimal currency. Far above any real shared
 * expense, low enough that a typo or a deliberately absurd amount cannot
 * overflow downstream arithmetic or make a balance sheet meaningless.
 */
export const MAX_AMOUNT_MINOR_UNITS = 1_000_000_000;

/**
 * Group size cap. `simplifyDebts` is O(n log n), so this is not about the
 * algorithm -- it is about keeping the per-request CPU budget predictable
 * (NFR-202) and failing with a clear validation error instead of a runtime
 * CPU-limit error.
 */
export const MAX_GROUP_MEMBERS = 50;

// Passwords shorter than 10 characters are already rejected, which rules out
// most of the classic leaked-password list. What remains worth blocking are
// the long ones people believe are clever (FR-102).
const COMMON_PASSWORDS = new Set([
  '1234567890',
  '12345678901',
  '123456789012',
  '1234567890123',
  'password123',
  'password1234',
  'password1!',
  'qwertyuiop',
  'qwerty12345',
  'letmein123',
  'iloveyou123',
  'welcome123',
  'admin12345',
  'administrator',
  'passw0rd123',
  'trustno1234',
  'abc123456789',
  'football123',
  'baseball123',
  'dragon12345',
  'sunshine123',
  'princess123',
  'monkey12345',
  'qazwsxedc123',
  '1q2w3e4r5t',
  'aaaaaaaaaa',
  'correcthorsebatterystaple',
]);

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(256, 'Password must be at most 256 characters')
  .refine((value) => !COMMON_PASSWORDS.has(value.toLowerCase().replace(/\s+/g, '')), {
    message: 'Password is too common. Choose something less guessable.',
  });

// Normalize before validating so "  Alice@Example.COM " and
// "alice@example.com" are the same account, and so the unique index on
// `users.email` is the only uniqueness rule that has to hold.
export const emailSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z.email().max(254),
);
export const displayNameSchema = z.string().trim().min(1).max(80);
export const uuidSchema = z.uuid();
export const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Currency must be a three-letter ISO 4217 code');

export const moneySchema = z
  .number()
  .int('Amount must be an integer in minor currency units')
  .positive('Amount must be greater than zero')
  .max(MAX_AMOUNT_MINOR_UNITS, 'Amount exceeds the maximum supported expense');

export const registerSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
});

export const loginSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(256),
});

export const refreshSchema = z.strictObject({ refreshToken: z.string().min(1).max(512) });

export const updateMeSchema = z.strictObject({ displayName: displayNameSchema });

export const createGroupSchema = z.strictObject({ name: z.string().trim().min(1).max(120) });

export const joinGroupSchema = z.strictObject({
  // Accept the code as a human would retype it -- any case, stray spaces --
  // then normalize to the stored form.
  inviteCode: z
    .string()
    .min(1)
    .max(40)
    .transform((code) => code.trim().toUpperCase().replace(/[^0-9A-Z-]/g, '')),
});

/**
 * A share map keyed by user id. Capped at the group-member ceiling so a
 * single request cannot ask for unbounded work.
 */
const shareMap = (valueSchema: z.ZodType<number>) =>
  z.record(uuidSchema, valueSchema).refine((map) => {
    const size = Object.keys(map).length;
    return size >= 1 && size <= MAX_GROUP_MEMBERS;
  }, `A split must name between 1 and ${MAX_GROUP_MEMBERS} participants`);

export const splitSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('equal'),
    participants: z.array(uuidSchema).min(1).max(MAX_GROUP_MEMBERS),
  }),
  z.strictObject({
    type: z.literal('exact'),
    amounts: shareMap(z.number().int().nonnegative().max(MAX_AMOUNT_MINOR_UNITS)),
  }),
  z.strictObject({
    type: z.literal('percentage'),
    percentages: shareMap(z.number().nonnegative().max(100)),
  }),
  z.strictObject({
    type: z.literal('shares'),
    shares: shareMap(z.number().int().nonnegative().max(10_000)),
  }),
]);

export const createExpenseSchema = z.strictObject({
  amount: moneySchema,
  currency: currencySchema,
  description: z.string().trim().min(1).max(280),
  paidBy: uuidSchema,
  split: splitSchema,
});

/** Partial updates are allowed, but at least one field must be present. */
export const updateExpenseSchema = createExpenseSchema.partial().refine(
  (body) => Object.keys(body).length > 0,
  'Provide at least one field to update',
);

export const createSettlementSchema = z.strictObject({
  toUserId: uuidSchema,
  amount: moneySchema,
  currency: currencySchema,
});

export const paginationSchema = z.strictObject({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

/**
 * Turn a Zod failure into the API's single error envelope (NFR-302). The
 * first issue drives the message, and every issue lands in `details` so a
 * client can highlight more than one field at a time.
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

/**
 * Parse a JSON body, treating an unparseable body as a validation error.
 * Typed against the shape it actually uses rather than a full Hono context,
 * so routers that extend the context variables can still call it.
 */
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

export function parsePagination(c: {
  req: { query: () => Record<string, string> };
}): { page: number; pageSize: number } {
  const { page, pageSize } = c.req.query();
  return parse(paginationSchema, {
    ...(page === undefined ? {} : { page }),
    ...(pageSize === undefined ? {} : { pageSize }),
  });
}

export function paginate<T>(items: T[], total: number, page: number, pageSize: number) {
  return {
    data: items,
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
}
