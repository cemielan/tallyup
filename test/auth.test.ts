import { describe, expect, it } from 'vitest';
import { api, expectError, json, nextIp, registerAndLogin } from './helpers';

describe('registration', () => {
  it('creates an account and returns no password material', async () => {
    const body = await json<{ user: Record<string, unknown> }>(
      await api('/v1/auth/register', {
        body: {
          email: 'newcomer@example.test',
          password: 'a-long-enough-passphrase-42',
          displayName: 'Newcomer',
        },
      }),
      201,
    );
    expect(body.user.email).toBe('newcomer@example.test');
    expect(Object.keys(body.user)).toEqual(['id', 'email', 'displayName']);
  });

  it('rejects a password under ten characters', async () => {
    await expectError(
      await api('/v1/auth/register', {
        body: { email: 'weak@example.test', password: 'short1', displayName: 'Weak' },
      }),
      422,
      'VALIDATION_ERROR',
    );
  });

  it('rejects a password from the common-password blocklist', async () => {
    await expectError(
      await api('/v1/auth/register', {
        body: { email: 'common@example.test', password: 'password1234', displayName: 'Common' },
      }),
      422,
      'VALIDATION_ERROR',
    );
  });

  it('rejects unknown fields rather than ignoring them', async () => {
    await expectError(
      await api('/v1/auth/register', {
        body: {
          email: 'overposter@example.test',
          password: 'a-long-enough-passphrase-42',
          displayName: 'Over',
          role: 'admin',
        },
      }),
      422,
      'VALIDATION_ERROR',
    );
  });

  it('refuses a duplicate email', async () => {
    const ip = nextIp();
    const body = {
      email: 'twice@example.test',
      password: 'a-long-enough-passphrase-42',
      displayName: 'Twice',
    };
    await json(await api('/v1/auth/register', { body, ip }), 201);
    await expectError(await api('/v1/auth/register', { body, ip }), 409, 'EMAIL_TAKEN');
  });
});

describe('login', () => {
  it('gives the same error for an unknown email and a wrong password', async () => {
    const session = await registerAndLogin('Known');

    const unknown = await expectError(
      await api('/v1/auth/login', {
        body: { email: 'nobody@example.test', password: 'a-long-enough-passphrase-42' },
      }),
      401,
      'INVALID_CREDENTIALS',
    );
    const wrong = await expectError(
      await api('/v1/auth/login', {
        body: { email: session.email, password: 'a-different-passphrase-99' },
      }),
      401,
      'INVALID_CREDENTIALS',
    );

    // Identical messages, so neither reveals whether the email is registered.
    expect(unknown.error).toEqual(wrong.error);
  });
});

describe('tokens', () => {
  it('rejects a request with no token, a malformed token, and a forged token', async () => {
    await expectError(await api('/v1/users/me'), 401, 'UNAUTHENTICATED');
    await expectError(await api('/v1/users/me', { token: 'not-a-jwt' }), 401, 'UNAUTHENTICATED');
    await expectError(
      await api('/v1/users/me', { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.forged' }),
      401,
      'UNAUTHENTICATED',
    );
  });

  it('refreshes a session and rotates the refresh token', async () => {
    const session = await registerAndLogin('Refresher');

    const refreshed = await json<{ accessToken: string; refreshToken: string }>(
      await api('/v1/auth/refresh', { body: { refreshToken: session.refreshToken } }),
    );
    expect(refreshed.refreshToken).not.toBe(session.refreshToken);

    // The new token works...
    await json(await api('/v1/users/me', { token: refreshed.accessToken }));
  });

  it('revokes every session when a used refresh token is replayed', async () => {
    const session = await registerAndLogin('Replayer');
    const first = await json<{ refreshToken: string }>(
      await api('/v1/auth/refresh', { body: { refreshToken: session.refreshToken } }),
    );

    // Replaying the spent token is treated as possible theft, so the whole
    // family dies -- including the token that legitimately replaced it.
    await expectError(
      await api('/v1/auth/refresh', { body: { refreshToken: session.refreshToken } }),
      401,
      'INVALID_REFRESH_TOKEN',
    );
    await expectError(
      await api('/v1/auth/refresh', { body: { refreshToken: first.refreshToken } }),
      401,
      'INVALID_REFRESH_TOKEN',
    );
  });

  it('revokes one token on logout and all of them on logout-all', async () => {
    const session = await registerAndLogin('Leaver');
    const second = await json<{ refreshToken: string; accessToken: string }>(
      await api('/v1/auth/login', {
        body: { email: session.email, password: 'a-long-enough-passphrase-42' },
        ip: session.ip,
      }),
    );

    expect(
      (
        await api('/v1/auth/logout', {
          body: { refreshToken: session.refreshToken },
          token: session.accessToken,
        })
      ).status,
    ).toBe(204);

    // The other session survives a single logout...
    await json(await api('/v1/auth/refresh', { body: { refreshToken: second.refreshToken } }));

    const third = await json<{ refreshToken: string }>(
      await api('/v1/auth/login', {
        body: { email: session.email, password: 'a-long-enough-passphrase-42' },
        ip: session.ip,
      }),
    );
    expect(
      (await api('/v1/auth/logout-all', { method: 'POST', token: session.accessToken })).status,
    ).toBe(204);
    await expectError(
      await api('/v1/auth/refresh', { body: { refreshToken: third.refreshToken } }),
      401,
      'INVALID_REFRESH_TOKEN',
    );
  });
});

describe('profile', () => {
  it('reads and updates the caller display name', async () => {
    const session = await registerAndLogin('Original');
    expect((await json<{ displayName: string }>(await api('/v1/users/me', { token: session.accessToken }))).displayName).toBe('Original');

    const updated = await json<{ displayName: string }>(
      await api('/v1/users/me', {
        method: 'PATCH',
        body: { displayName: 'Renamed' },
        token: session.accessToken,
      }),
    );
    expect(updated.displayName).toBe('Renamed');
  });
});

describe('rate limiting', () => {
  it('returns 429 with Retry-After once the login limit is spent', async () => {
    const ip = nextIp();
    const body = { email: 'ratelimited@example.test', password: 'a-long-enough-passphrase-42' };

    // Five attempts per five minutes per IP (docs/05-SECURITY.md §4).
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await api('/v1/auth/login', { body, ip });
      expect(response.status).toBe(401);
    }

    const limited = await api('/v1/auth/login', { body, ip });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    await expectError(limited, 429, 'RATE_LIMITED');
  });
});
