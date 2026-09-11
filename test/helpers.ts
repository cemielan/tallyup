import { SELF } from 'cloudflare:test';
import { expect } from 'vitest';

export interface Session {
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  ip: string;
}

interface CallOptions {
  method?: string;
  token?: string;
  body?: unknown;
  /**
   * Rate limits on the auth endpoints are keyed per IP, so every test caller
   * gets its own address. Otherwise the sixth registration in the file would
   * fail for reasons the test is not about.
   */
  ip?: string;
}

let ipCounter = 0;
export const nextIp = () => `203.0.113.${(ipCounter += 1) % 255}`;

export async function api(path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'cf-connecting-ip': options.ip ?? nextIp(),
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  return SELF.fetch(`https://tallyup.test${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

/** Assert a successful response and return its JSON, or fail loudly. */
export async function json<T = any>(response: Response, expectedStatus = 200): Promise<T> {
  const text = await response.text();
  expect(
    response.status,
    `expected ${expectedStatus} but got ${response.status}: ${text}`,
  ).toBe(expectedStatus);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export async function expectError(response: Response, status: number, code: string) {
  const body = await json<{ error: { code: string } }>(response, status);
  expect(body.error.code).toBe(code);
  return body;
}

let userCounter = 0;

export async function registerAndLogin(displayName: string): Promise<Session> {
  const ip = nextIp();
  const email = `user${(userCounter += 1)}@example.test`;
  const password = 'a-long-enough-passphrase-42';

  await json(await api('/v1/auth/register', { body: { email, password, displayName }, ip }), 201);
  const session = await json<{
    accessToken: string;
    refreshToken: string;
    user: { id: string };
  }>(await api('/v1/auth/login', { body: { email, password }, ip }));

  return {
    userId: session.user.id,
    email,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    ip,
  };
}

export async function createGroup(session: Session, name: string) {
  return json<{ id: string; inviteCode: string }>(
    await api('/v1/groups', { body: { name }, token: session.accessToken }),
    201,
  );
}

export async function joinGroup(session: Session, inviteCode: string) {
  return json(
    await api('/v1/groups/join', { body: { inviteCode }, token: session.accessToken, ip: nextIp() }),
  );
}

export async function addExpense(
  session: Session,
  groupId: string,
  body: Record<string, unknown>,
) {
  return json<{ id: string }>(
    await api(`/v1/groups/${groupId}/expenses`, { body, token: session.accessToken }),
    201,
  );
}

export async function getBalances(session: Session, groupId: string) {
  return json<{
    balances: Array<{ userId: string; amount: number; currency: string }>;
  }>(await api(`/v1/groups/${groupId}/balances`, { token: session.accessToken }));
}

export async function getSuggested(session: Session, groupId: string) {
  return json<{
    suggested: Array<{ from: string; to: string; amount: number; currency: string }>;
  }>(await api(`/v1/groups/${groupId}/settlements/suggested`, { token: session.accessToken }));
}

/** A member's balance in one currency, or 0 when they are settled up. */
export function balanceOf(
  balances: Array<{ userId: string; amount: number; currency: string }>,
  userId: string,
  currency = 'USD',
): number {
  return balances.find((b) => b.userId === userId && b.currency === currency)?.amount ?? 0;
}
