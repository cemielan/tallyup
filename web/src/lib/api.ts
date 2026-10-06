import { open, seal, type Sealed } from './crypto';
import { LIMITS, claimSchema, parseDoc, type Claim, type EventDoc } from './doc';
import { getPass } from './pass';

/** Thin client for /v1/shares. Everything it sends is ciphertext. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Messages for failures that arrive without our error envelope: the
 * platform's own responses once a free-tier daily limit is used up, or a
 * network that is simply down.
 */
function platformError(status: number): ApiError {
  if (status === 429 || status === 503 || status >= 520) {
    return new ApiError(status, 'BUSY', 'Tallyup is very busy right now. Your changes are safe on this phone. Try again in a little while.');
  }
  return new ApiError(status, 'UNKNOWN', 'Something went wrong. Try again.');
}

async function call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);

  let response: Response;
  try {
    response = await fetch(`/v1/shares${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, 'OFFLINE', 'No connection. Check your internet and try again.');
  }
  if (response.status === 204) return undefined as T;

  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = body?.error;
    if (!error?.code) throw platformError(response.status);
    throw new ApiError(response.status, error.code, error.message ?? 'Request failed');
  }
  return body as T;
}

/** Fail on this device, with a useful message, rather than at the server with a 422. */
function checkSize(sealed: Sealed): Sealed {
  if (sealed.ciphertext.length > LIMITS.ciphertext) {
    throw new ApiError(413, 'TOO_BIG', 'This event is too big to share. Split it into two events.');
  }
  return sealed;
}

export interface ClaimRow extends Claim {
  claimId: string;
}

export interface Loaded {
  doc: EventDoc;
  version: number;
  expiresAt: string;
  claims: ClaimRow[];
}

/** The event and its pending claims, decrypted, in one request. */
export async function loadEvent(id: string, key: string): Promise<Loaded> {
  const share = await call<Sealed & { version: number; expiresAt: string; claims: Array<Sealed & { id: string }> }>(`/${id}`);
  let doc: EventDoc;
  try {
    doc = parseDoc(await open(key, share));
  } catch {
    throw new ApiError(400, 'BAD_KEY', 'This link is broken or was reset by the host.');
  }

  // A claim that fails to decrypt or validate is skipped, not fatal: claims
  // are written by anyone holding the link.
  const claims = await Promise.all(
    share.claims.map(async (row) => {
      try {
        return { ...claimSchema.parse(await open(key, row)), claimId: row.id };
      } catch {
        return undefined;
      }
    }),
  );

  return {
    doc,
    version: share.version,
    expiresAt: share.expiresAt,
    claims: claims.filter((row) => row !== undefined),
  };
}

/**
 * A POST that needs a client pass. A pass the server no longer accepts
 * (expired, or the signing key was rotated) earns one fresh check and one
 * retry, never a loop.
 */
async function withPass<T>(path: string, body: string): Promise<T> {
  const send = async (fresh: boolean) =>
    call<T>(path, { method: 'POST', body, headers: { 'X-Tallyup-Pass': await getPass(fresh) } });
  try {
    return await send(false);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'PASS_REQUIRED') return send(true);
    throw error;
  }
}

export async function createEvent(key: string, doc: EventDoc) {
  return withPass<{ id: string; editToken: string; version: number; expiresAt: string }>(
    '',
    JSON.stringify(checkSize(await seal(key, doc))),
  );
}

export async function updateEvent(id: string, key: string, token: string, doc: EventDoc, version: number) {
  return call<{ version: number; expiresAt: string }>(`/${id}`, {
    method: 'PUT',
    token,
    body: JSON.stringify({ ...checkSize(await seal(key, doc)), version }),
  });
}

export const deleteEvent = (id: string, token: string) => call<void>(`/${id}`, { method: 'DELETE', token });

export async function sendClaim(id: string, key: string, claim: Claim) {
  return withPass<{ id: string }>(`/${id}/claims`, JSON.stringify(await seal(key, claim)));
}

export const deleteClaim = (id: string, token: string, claimId: string) =>
  call<void>(`/${id}/claims/${claimId}`, { method: 'DELETE', token });
