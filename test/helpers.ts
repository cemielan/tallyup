import { SELF, env } from 'cloudflare:test';
import { expect } from 'vitest';
import { signPass } from '../src/crypto';

interface CallOptions {
  method?: string;
  token?: string;
  body?: unknown;
  /**
   * Rate limits are keyed per IP, so every call gets its own address unless
   * a test is about the limit itself. Otherwise the thirty-first share
   * created in a file would fail for reasons the test is not about.
   */
  ip?: string;
  /**
   * The client pass for a POST. By default every POST gets a freshly minted
   * one, so per-pass limits never interfere with tests about something else.
   * `false` sends none.
   */
  pass?: string | false;
}

/** A pass exactly as POST /v1/pass would issue it, without the Turnstile round trip. */
export const mintPass = (expiresAt = Date.now() + 60_000) => signPass(env.PASS_SECRET, expiresAt);

let ipCounter = 0;
export const nextIp = () => `203.0.${Math.floor(ipCounter / 250)}.${(ipCounter += 1) % 250}`;

export async function api(path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { 'cf-connecting-ip': options.ip ?? nextIp() };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  if (method === 'POST' && options.pass !== false) headers['X-Tallyup-Pass'] = options.pass ?? (await mintPass());

  return SELF.fetch(`https://tallyup.test${path}`, {
    method,
    headers,
    ...(options.body === undefined
      ? {}
      : { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) }),
  });
}

/** Assert a status and return the JSON body, or fail loudly with the text. */
export async function json<T = any>(response: Response, expectedStatus = 200): Promise<T> {
  const text = await response.text();
  expect(response.status, `expected ${expectedStatus} but got ${response.status}: ${text}`).toBe(
    expectedStatus,
  );
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export async function expectError(response: Response, status: number, code: string) {
  const body = await json<{ error: { code: string } }>(response, status);
  expect(body.error.code).toBe(code);
  return body;
}

/** Ciphertext stand-ins. The server never decrypts, so any base64url will do. */
export const sealed = (tag = 'abc') => ({ ciphertext: `ZmFrZS1jaXBoZXJ0ZXh0-${tag}`, iv: 'AAAAAAAAAAAAAAAA' });

export async function createShare(tag?: string) {
  return json<{ id: string; editToken: string; version: number; expiresAt: string }>(
    await api('/v1/shares', { body: sealed(tag) }),
    201,
  );
}
