import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * The complete set of machine-matchable error codes (docs/04-API-SPEC.md §4).
 * Every error the API returns uses one of these -- clients match on `code`,
 * never on `message`.
 */
export const ERROR_CODES = {
  VALIDATION_ERROR: 422,
  UNAUTHENTICATED: 401,
  PASS_REQUIRED: 401,
  FORBIDDEN: 403,
  CHALLENGE_FAILED: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  CLAIM_LIMIT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  AT_CAPACITY: 503,
} as const satisfies Record<string, ContentfulStatusCode>;

export type ErrorCode = keyof typeof ERROR_CODES;

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: ContentfulStatusCode;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: unknown; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_CODES[code];
    this.details = options.details;
    this.headers = options.headers;
  }

  toResponseBody() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

/** Shorthand for the cases raised from more than one place. */
export const errors = {
  notFound: (what = 'Resource') => new ApiError('NOT_FOUND', `${what} not found`),
  unauthenticated: (message = 'Missing edit token') => new ApiError('UNAUTHENTICATED', message),
  forbidden: (message = 'Invalid edit token') => new ApiError('FORBIDDEN', message),
  validation: (message: string, details?: unknown) =>
    new ApiError('VALIDATION_ERROR', message, { details }),
};
