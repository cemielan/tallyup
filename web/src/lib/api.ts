import { open, seal, type Sealed } from './crypto';
import { claimSchema, parseDoc, type Claim, type EventDoc } from './doc';

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

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? 'Request failed');
  }
  return body as T;
}

export interface Loaded {
  doc: EventDoc;
  version: number;
  expiresAt: string;
}

export async function loadEvent(id: string, key: string): Promise<Loaded> {
  const share = await call<Sealed & { version: number; expiresAt: string }>(`/${id}`);
  let doc: EventDoc;
  try {
    doc = parseDoc(await open(key, share));
  } catch {
    throw new ApiError(400, 'BAD_KEY', 'This link is broken or was reset by the host.');
  }
  return { doc, version: share.version, expiresAt: share.expiresAt };
}

export async function createEvent(key: string, doc: EventDoc) {
  return call<{ id: string; editToken: string; version: number; expiresAt: string }>('', {
    method: 'POST',
    body: JSON.stringify(await seal(key, doc)),
  });
}

export async function updateEvent(id: string, key: string, token: string, doc: EventDoc, version: number) {
  return call<{ version: number; expiresAt: string }>(`/${id}`, {
    method: 'PUT',
    token,
    body: JSON.stringify({ ...(await seal(key, doc)), version }),
  });
}

export const deleteEvent = (id: string, token: string) => call<void>(`/${id}`, { method: 'DELETE', token });

export interface ClaimRow extends Claim {
  claimId: string;
}

/** Pending claims, decrypted. One that fails to decrypt or validate is skipped, not fatal. */
export async function loadClaims(id: string, key: string): Promise<ClaimRow[]> {
  const { claims } = await call<{ claims: Array<Sealed & { id: string }> }>(`/${id}/claims`);
  const rows = await Promise.all(
    claims.map(async (row) => {
      try {
        return { ...claimSchema.parse(await open(key, row)), claimId: row.id };
      } catch {
        return undefined;
      }
    }),
  );
  return rows.filter((row) => row !== undefined);
}

export async function sendClaim(id: string, key: string, claim: Claim) {
  return call<{ id: string }>(`/${id}/claims`, { method: 'POST', body: JSON.stringify(await seal(key, claim)) });
}

export const deleteClaim = (id: string, token: string, claimId: string) =>
  call<void>(`/${id}/claims/${claimId}`, { method: 'DELETE', token });
