import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * The complete set of machine-matchable error codes (docs/04-API-SPEC.md §5).
 * Every error the API returns uses one of these -- clients match on `code`,
 * never on `message`.
 */
export const ERROR_CODES = {
  VALIDATION_ERROR: 422,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  INVALID_REFRESH_TOKEN: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  EMAIL_TAKEN: 409,
  ALREADY_MEMBER: 409,
  NONZERO_BALANCE: 409,
  NON_MEMBER_PARTICIPANT: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
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
  unauthenticated: (message = 'Missing or invalid access token') =>
    new ApiError('UNAUTHENTICATED', message),
  forbidden: (message = 'You are not permitted to perform this action') =>
    new ApiError('FORBIDDEN', message),
  validation: (message: string, details?: unknown) =>
    new ApiError('VALIDATION_ERROR', message, { details }),
};
