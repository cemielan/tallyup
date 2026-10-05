import { z } from 'zod';
import { ERROR_CODES } from './errors';
import * as v from './validation';

/**
 * The OpenAPI document is generated from the very Zod schemas the routes
 * validate with, so a schema change cannot drift from the published
 * contract. Only the path/method/response metadata is written out here,
 * because that lives in the router, not in a schema.
 */

const jsonSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });

const editToken = [{ editToken: [] }];

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

const jsonBody = (schema: z.ZodType) => ({
  required: true,
  content: { 'application/json': { schema: jsonSchema(schema) } },
});

const ok = (description: string) => ({ description });

const pathParam = (name: string) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{22}$' },
});

const shareId = pathParam('shareId');

let cached: object | undefined;

export function openApiDocument(serverUrl: string): object {
  if (cached) return cached;

  cached = {
    openapi: '3.1.0',
    info: {
      title: 'Tallyup API',
      version: '1.0.0',
      description:
        'Store and share end-to-end encrypted split-bill events. The server only ever sees ' +
        'ciphertext: clients encrypt the event document with AES-256-GCM before upload and keep ' +
        'the key in the share link fragment. See docs/04-API-SPEC.md for the document format and ' +
        'the encryption scheme a client must implement.',
      license: { name: 'MIT' },
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        editToken: {
          type: 'http',
          scheme: 'bearer',
          description: 'The edit token returned once by POST /shares.',
        },
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
      },
    },
    paths: {
      '/shares': {
        post: {
          summary: 'Create a share from an encrypted event document',
          requestBody: jsonBody(v.createShareSchema),
          responses: {
            201: ok('Created. The response carries the edit token; it is never shown again'),
            422: errorResponse('VALIDATION_ERROR'),
            429: errorResponse('RATE_LIMITED'),
            503: errorResponse('AT_CAPACITY'),
          },
        },
      },
      '/shares/{shareId}': {
        get: {
          summary: 'Fetch a share ciphertext',
          parameters: [shareId],
          responses: {
            200: ok('The ciphertext, its version, and pending claims (ciphertext)'),
            404: errorResponse('NOT_FOUND'),
          },
        },
        put: {
          summary: 'Replace the ciphertext (compare-and-swap on version)',
          security: editToken,
          parameters: [shareId],
          requestBody: jsonBody(v.updateShareSchema),
          responses: {
            200: ok('Updated; the expiry moves forward 30 days'),
            401: errorResponse('UNAUTHENTICATED'),
            403: errorResponse('FORBIDDEN'),
            409: errorResponse('VERSION_CONFLICT'),
          },
        },
        delete: {
          summary: 'Delete a share and its claims',
          security: editToken,
          parameters: [shareId],
          responses: { 204: ok('Deleted'), 403: errorResponse('FORBIDDEN') },
        },
      },
      '/shares/{shareId}/claims': {
        post: {
          summary: 'Add an encrypted "I paid" claim',
          parameters: [shareId],
          requestBody: jsonBody(v.createClaimSchema),
          responses: {
            201: ok('Claim stored'),
            409: errorResponse('CLAIM_LIMIT'),
            429: errorResponse('RATE_LIMITED'),
          },
        },
      },
      '/shares/{shareId}/claims/{claimId}': {
        delete: {
          summary: 'Remove a claim after confirming or declining it',
          security: editToken,
          parameters: [shareId, pathParam('claimId')],
          responses: { 204: ok('Removed'), 404: errorResponse('NOT_FOUND') },
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
