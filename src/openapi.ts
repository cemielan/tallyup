import { z } from 'zod';
import { ERROR_CODES } from './errors';
import * as v from './validation';

/**
 * The OpenAPI document is generated from the very Zod schemas the routes
 * validate with (NFR-301), so a schema change cannot drift from the
 * published contract -- there is no second definition to forget to update.
 * Only the path/method/response metadata is written out here, because that
 * lives in the router, not in a schema.
 */

const jsonSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });

const bearer = [{ bearerAuth: [] }];

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

const jsonBody = (schema: z.ZodType) => ({
  required: true,
  content: { 'application/json': { schema: jsonSchema(schema) } },
});

const ok = (description: string) => ({ description });

const paginationParams = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
  {
    name: 'pageSize',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
];

const pathParam = (name: string) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
});

let cached: object | undefined;

export function openApiDocument(serverUrl: string): object {
  if (cached) return cached;

  cached = {
    openapi: '3.1.0',
    info: {
      title: 'Tallyup API',
      version: '0.1.0',
      description:
        'Track shared group expenses and compute the minimum set of payments needed to settle up. ' +
        'All monetary amounts are integers in minor currency units (1050 = $10.50).',
      license: { name: 'MIT' },
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string', enum: Object.keys(ERROR_CODES) },
                message: { type: 'string' },
                details: {},
              },
            },
          },
        },
        Split: jsonSchema(v.splitSchema),
      },
    },
    paths: {
      '/auth/register': {
        post: {
          summary: 'Register a new account',
          requestBody: jsonBody(v.registerSchema),
          responses: {
            201: ok('Account created'),
            409: errorResponse('EMAIL_TAKEN'),
            422: errorResponse('VALIDATION_ERROR'),
            429: errorResponse('RATE_LIMITED'),
          },
        },
      },
      '/auth/login': {
        post: {
          summary: 'Exchange credentials for an access and refresh token',
          requestBody: jsonBody(v.loginSchema),
          responses: {
            200: ok('Session issued'),
            401: errorResponse('INVALID_CREDENTIALS'),
            429: errorResponse('RATE_LIMITED'),
          },
        },
      },
      '/auth/refresh': {
        post: {
          summary: 'Rotate a refresh token for a new session',
          requestBody: jsonBody(v.refreshSchema),
          responses: {
            200: ok('Session issued; the previous refresh token is now revoked'),
            401: errorResponse('INVALID_REFRESH_TOKEN'),
          },
        },
      },
      '/auth/logout': {
        post: {
          summary: 'Revoke one refresh token',
          security: bearer,
          requestBody: jsonBody(v.refreshSchema),
          responses: { 204: ok('Revoked'), 401: errorResponse('UNAUTHENTICATED') },
        },
      },
      '/auth/logout-all': {
        post: {
          summary: 'Revoke every refresh token for the caller',
          security: bearer,
          responses: { 204: ok('Revoked'), 401: errorResponse('UNAUTHENTICATED') },
        },
      },
      '/users/me': {
        get: {
          summary: 'Fetch the caller profile',
          security: bearer,
          responses: { 200: ok('The caller'), 401: errorResponse('UNAUTHENTICATED') },
        },
        patch: {
          summary: 'Update the caller display name',
          security: bearer,
          requestBody: jsonBody(v.updateMeSchema),
          responses: { 200: ok('Updated'), 422: errorResponse('VALIDATION_ERROR') },
        },
      },
      '/groups': {
        get: {
          summary: 'List groups the caller belongs to',
          security: bearer,
          parameters: paginationParams,
          responses: { 200: ok('Paginated groups') },
        },
        post: {
          summary: 'Create a group; the creator becomes its owner',
          security: bearer,
          requestBody: jsonBody(v.createGroupSchema),
          responses: { 201: ok('Group created'), 422: errorResponse('VALIDATION_ERROR') },
        },
      },
      '/groups/join': {
        post: {
          summary: 'Join a group with an invite code',
          security: bearer,
          requestBody: jsonBody(v.joinGroupSchema),
          responses: {
            200: ok('Joined'),
            404: errorResponse('Invite code is not valid'),
            409: errorResponse('ALREADY_MEMBER'),
            429: errorResponse('RATE_LIMITED'),
          },
        },
      },
      '/groups/{groupId}': {
        get: {
          summary: 'Group detail, including the member list',
          security: bearer,
          parameters: [pathParam('groupId')],
          responses: {
            200: ok('Group detail'),
            404: errorResponse('Not found, or the caller is not a member'),
          },
        },
      },
      '/groups/{groupId}/invite/rotate': {
        post: {
          summary: 'Replace the invite code, invalidating the old one',
          security: bearer,
          parameters: [pathParam('groupId')],
          responses: { 200: ok('New invite code'), 403: errorResponse('FORBIDDEN') },
        },
      },
      '/groups/{groupId}/members/{userId}': {
        delete: {
          summary: 'Remove a member, or leave the group by naming yourself',
          security: bearer,
          parameters: [pathParam('groupId'), pathParam('userId')],
          responses: {
            204: ok('Removed'),
            403: errorResponse('FORBIDDEN'),
            409: errorResponse('NONZERO_BALANCE'),
          },
        },
      },
      '/groups/{groupId}/expenses': {
        get: {
          summary: 'List a group expenses, newest first',
          security: bearer,
          parameters: [pathParam('groupId'), ...paginationParams],
          responses: { 200: ok('Paginated expenses') },
        },
        post: {
          summary: 'Record an expense',
          security: bearer,
          parameters: [pathParam('groupId')],
          requestBody: jsonBody(v.createExpenseSchema),
          responses: {
            201: ok('Expense created, with resolved per-person shares'),
            422: errorResponse('VALIDATION_ERROR or NON_MEMBER_PARTICIPANT'),
          },
        },
      },
      '/expenses/{expenseId}': {
        get: {
          summary: 'Expense detail with its full split breakdown',
          security: bearer,
          parameters: [pathParam('expenseId')],
          responses: { 200: ok('Expense detail'), 404: errorResponse('NOT_FOUND') },
        },
        patch: {
          summary: 'Edit an expense (creator or group owner only)',
          security: bearer,
          parameters: [pathParam('expenseId')],
          requestBody: jsonBody(v.updateExpenseSchema),
          responses: {
            200: ok('Updated; balances recompute from the new values'),
            403: errorResponse('FORBIDDEN'),
            422: errorResponse('VALIDATION_ERROR'),
          },
        },
        delete: {
          summary: 'Soft-delete an expense (creator or group owner only)',
          security: bearer,
          parameters: [pathParam('expenseId')],
          responses: { 204: ok('Deleted'), 403: errorResponse('FORBIDDEN') },
        },
      },
      '/groups/{groupId}/balances': {
        get: {
          summary: 'Net balance per member, per currency',
          security: bearer,
          parameters: [pathParam('groupId')],
          responses: { 200: ok('One entry per non-zero (user, currency) pair') },
        },
      },
      '/groups/{groupId}/settlements/suggested': {
        get: {
          summary: 'Minimum set of payments that settles the group',
          security: bearer,
          parameters: [pathParam('groupId')],
          responses: { 200: ok('Computed fresh from current balances; not a stored resource') },
        },
      },
      '/groups/{groupId}/settlements': {
        get: {
          summary: 'List settlements for a group',
          security: bearer,
          parameters: [pathParam('groupId'), ...paginationParams],
          responses: { 200: ok('Paginated settlements') },
        },
        post: {
          summary: 'Propose a settlement from the caller to another member',
          security: bearer,
          parameters: [pathParam('groupId')],
          requestBody: jsonBody(v.createSettlementSchema),
          responses: {
            201: ok('Pending settlement created; balances are unchanged until confirmed'),
            422: errorResponse('VALIDATION_ERROR or NON_MEMBER_PARTICIPANT'),
          },
        },
      },
      '/settlements/{settlementId}/confirm': {
        post: {
          summary: 'Confirm receipt of a payment (receiving party only)',
          security: bearer,
          parameters: [pathParam('settlementId')],
          responses: {
            200: ok('Confirmed; a balancing expense now exists'),
            404: errorResponse('Not found, or the caller is not the recipient'),
          },
        },
      },
      '/settlements/{settlementId}/decline': {
        post: {
          summary: 'Decline a claimed payment (receiving party only)',
          security: bearer,
          parameters: [pathParam('settlementId')],
          responses: { 200: ok('Declined; balances are unchanged') },
        },
      },
    },
  };

  return cached;
}

/** Scalar renders the generated document. No build step, no extra hosting. */
export const docsPage = (specUrl: string) => `<!doctype html>
<html>
  <head>
    <title>Tallyup API reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="${specUrl}"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;
