import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sweepExpired } from '../src/index';
import { RATE_LIMITS, clientKey } from '../src/middleware';
import { MAX_CLAIMS_PER_SHARE, MAX_SHARE_CIPHERTEXT } from '../src/validation';
import { api, createShare, expectError, json, mintPass, nextIp, sealed } from './helpers';

describe('POST /v1/shares', () => {
  it('stores ciphertext and returns an edit token exactly once', async () => {
    const share = await createShare();
    expect(share.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(share.editToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(share.version).toBe(1);

    const fetched = await json(await api(`/v1/shares/${share.id}`));
    expect(fetched).toMatchObject({ id: share.id, ...sealed(), version: 1 });
    expect(fetched).not.toHaveProperty('editToken');
    expect(fetched).not.toHaveProperty('editTokenHash');
  });

  it('keeps only a hash of the edit token', async () => {
    const share = await createShare();
    const row = await env.DB.prepare('SELECT edit_token_hash FROM shares WHERE id = ?')
      .bind(share.id)
      .first<{ edit_token_hash: string }>();
    expect(row?.edit_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.edit_token_hash).not.toContain(share.editToken);
  });

  it('rejects unknown fields rather than storing them', async () => {
    await expectError(
      await api('/v1/shares', { body: { ...sealed(), title: 'plaintext leak' } }),
      422,
      'VALIDATION_ERROR',
    );
  });

  it('rejects ciphertext that is not base64url', async () => {
    await expectError(
      await api('/v1/shares', { body: { ciphertext: 'not base64!', iv: sealed().iv } }),
      422,
      'VALIDATION_ERROR',
    );
  });

  it('rejects ciphertext over the cap', async () => {
    const ciphertext = 'A'.repeat(MAX_SHARE_CIPHERTEXT + 1);
    await expectError(
      await api('/v1/shares', { body: { ciphertext, iv: sealed().iv } }),
      422,
      'VALIDATION_ERROR',
    );
  });

  it('answers an oversized body with the error envelope, not a bare 413', async () => {
    const ciphertext = 'A'.repeat(70 * 1024);
    await expectError(
      await api('/v1/shares', { body: { ciphertext, iv: sealed().iv } }),
      413,
      'PAYLOAD_TOO_LARGE',
    );
  });

  it('rejects a body that is not JSON', async () => {
    await expectError(await api('/v1/shares', { body: '{nope' }), 422, 'VALIDATION_ERROR');
  });

  it('limits creation per client pass, whatever address it comes from', async () => {
    const pass = await mintPass();
    for (let i = 0; i < RATE_LIMITS.create.limit; i += 1) {
      await json(await api('/v1/shares', { body: sealed(), pass }), 201);
    }
    const blocked = await api('/v1/shares', { body: sealed(), pass });
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
    await expectError(blocked, 429, 'RATE_LIMITED');
  });

  it('does not make strangers on one shared address share that limit', async () => {
    const ip = nextIp();
    for (let i = 0; i < RATE_LIMITS.create.limit + 5; i += 1) {
      await json(await api('/v1/shares', { body: sealed(), ip }), 201);
    }
  });

  it('still caps one address that mints many passes', async () => {
    const ip = nextIp();
    for (let i = 0; i < RATE_LIMITS.createBackstop.limit; i += 1) {
      await json(await api('/v1/shares', { body: sealed(), ip }), 201);
    }
    await expectError(await api('/v1/shares', { body: sealed(), ip }), 429, 'RATE_LIMITED');
  }, 30_000);

  it('requires a client pass', async () => {
    await expectError(await api('/v1/shares', { body: sealed(), pass: false }), 401, 'PASS_REQUIRED');
  });

  it('rejects an expired or forged pass', async () => {
    const expired = await mintPass(Date.now() - 1);
    await expectError(await api('/v1/shares', { body: sealed(), pass: expired }), 401, 'PASS_REQUIRED');
    const valid = await mintPass();
    const forged = `${valid.slice(0, -2)}${valid.endsWith('AA') ? 'BB' : 'AA'}`;
    await expectError(await api('/v1/shares', { body: sealed(), pass: forged }), 401, 'PASS_REQUIRED');
    await expectError(await api('/v1/shares', { body: sealed(), pass: 'nonsense' }), 401, 'PASS_REQUIRED');
  });
});

describe('GET /v1/shares/:id', () => {
  it('404s an unknown share', async () => {
    await expectError(await api('/v1/shares/AAAAAAAAAAAAAAAAAAAAAA'), 404, 'NOT_FOUND');
  });

  it('422s a malformed id', async () => {
    await expectError(await api('/v1/shares/short'), 422, 'VALIDATION_ERROR');
  });

  it('treats an expired share as missing before the sweep runs', async () => {
    const share = await createShare();
    await env.DB.prepare('UPDATE shares SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1, share.id)
      .run();
    await expectError(await api(`/v1/shares/${share.id}`), 404, 'NOT_FOUND');
  });

  it('sends no CORS headers, so other sites cannot read responses', async () => {
    const share = await createShare();
    const response = await api(`/v1/shares/${share.id}`);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('PUT /v1/shares/:id', () => {
  it('replaces the ciphertext and bumps the version', async () => {
    const share = await createShare();
    const updated = await json(
      await api(`/v1/shares/${share.id}`, {
        method: 'PUT',
        token: share.editToken,
        body: { ...sealed('v2'), version: 1 },
      }),
    );
    expect(updated.version).toBe(2);

    const fetched = await json(await api(`/v1/shares/${share.id}`));
    expect(fetched.ciphertext).toBe(sealed('v2').ciphertext);
  });

  it('moves the expiry forward', async () => {
    const share = await createShare();
    await env.DB.prepare('UPDATE shares SET expires_at = ? WHERE id = ?')
      .bind(Date.now() + 1000, share.id)
      .run();
    const updated = await json(
      await api(`/v1/shares/${share.id}`, {
        method: 'PUT',
        token: share.editToken,
        body: { ...sealed(), version: 1 },
      }),
    );
    expect(Date.parse(updated.expiresAt)).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
  });

  it('refuses a stale version instead of overwriting', async () => {
    const share = await createShare();
    const put = (version: number) =>
      api(`/v1/shares/${share.id}`, {
        method: 'PUT',
        token: share.editToken,
        body: { ...sealed(), version },
      });

    await json(await put(1));
    const conflict = await expectError(await put(1), 409, 'VERSION_CONFLICT');
    expect(conflict).toMatchObject({ error: { details: { currentVersion: 2 } } });
  });

  it('401s without a token and 403s with the wrong one', async () => {
    const share = await createShare();
    const other = await createShare();
    const body = { ...sealed(), version: 1 };

    await expectError(
      await api(`/v1/shares/${share.id}`, { method: 'PUT', body }),
      401,
      'UNAUTHENTICATED',
    );
    await expectError(
      await api(`/v1/shares/${share.id}`, { method: 'PUT', body, token: other.editToken }),
      403,
      'FORBIDDEN',
    );
  });
});

describe('DELETE /v1/shares/:id', () => {
  it('deletes the share and its claims', async () => {
    const share = await createShare();
    await json(await api(`/v1/shares/${share.id}/claims`, { body: sealed() }), 201);

    await json(await api(`/v1/shares/${share.id}`, { method: 'DELETE', token: share.editToken }), 204);
    await expectError(await api(`/v1/shares/${share.id}`), 404, 'NOT_FOUND');

    const orphans = await env.DB.prepare('SELECT COUNT(*) AS n FROM share_claims WHERE share_id = ?')
      .bind(share.id)
      .first<{ n: number }>();
    expect(orphans?.n).toBe(0);
  });

  it('403s the wrong token', async () => {
    const share = await createShare();
    await expectError(
      await api(`/v1/shares/${share.id}`, { method: 'DELETE', token: 'wrong' }),
      403,
      'FORBIDDEN',
    );
  });
});

describe('claims', () => {
  it('lets anyone with the id add a claim and lets the host remove it', async () => {
    const share = await createShare();
    const claim = await json(
      await api(`/v1/shares/${share.id}/claims`, { body: sealed('claim') }),
      201,
    );

    const listed = await json(await api(`/v1/shares/${share.id}`));
    expect(listed.claims).toEqual([
      expect.objectContaining({ id: claim.id, ...sealed('claim') }),
    ]);

    await expectError(
      await api(`/v1/shares/${share.id}/claims/${claim.id}`, { method: 'DELETE' }),
      401,
      'UNAUTHENTICATED',
    );
    await json(
      await api(`/v1/shares/${share.id}/claims/${claim.id}`, {
        method: 'DELETE',
        token: share.editToken,
      }),
      204,
    );
    expect((await json(await api(`/v1/shares/${share.id}`))).claims).toEqual([]);
  });

  it('cannot delete a claim through another share', async () => {
    const mine = await createShare();
    const theirs = await createShare();
    const claim = await json(await api(`/v1/shares/${theirs.id}/claims`, { body: sealed() }), 201);

    await expectError(
      await api(`/v1/shares/${mine.id}/claims/${claim.id}`, {
        method: 'DELETE',
        token: mine.editToken,
      }),
      404,
      'NOT_FOUND',
    );
  });

  it('caps unanswered claims per share', async () => {
    const share = await createShare();
    for (let i = 0; i < MAX_CLAIMS_PER_SHARE; i += 1) {
      await json(await api(`/v1/shares/${share.id}/claims`, { body: sealed() }), 201);
    }
    await expectError(
      await api(`/v1/shares/${share.id}/claims`, { body: sealed() }),
      409,
      'CLAIM_LIMIT',
    );
  });

  it('404s claims on an unknown share', async () => {
    await expectError(
      await api('/v1/shares/AAAAAAAAAAAAAAAAAAAAAA/claims', { body: sealed() }),
      404,
      'NOT_FOUND',
    );
  });
});

describe('sweepExpired', () => {
  it('deletes lapsed shares with their claims and keeps live ones', async () => {
    const live = await createShare();
    const lapsed = await createShare();
    await json(await api(`/v1/shares/${lapsed.id}/claims`, { body: sealed() }), 201);
    await env.DB.prepare('UPDATE shares SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1, lapsed.id)
      .run();

    await sweepExpired(env.DB);

    const ids = await env.DB.prepare('SELECT id FROM shares WHERE id IN (?, ?)')
      .bind(live.id, lapsed.id)
      .all<{ id: string }>();
    expect(ids.results.map((row) => row.id)).toEqual([live.id]);

    const claims = await env.DB.prepare('SELECT COUNT(*) AS n FROM share_claims WHERE share_id = ?')
      .bind(lapsed.id)
      .first<{ n: number }>();
    expect(claims?.n).toBe(0);
  });

  it('deletes expired rate-limit windows', async () => {
    await env.DB.prepare('INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)')
      .bind('test:old', Date.now() - 1)
      .run();
    await sweepExpired(env.DB);
    const row = await env.DB.prepare("SELECT key FROM rate_limits WHERE key = 'test:old'").first();
    expect(row).toBeNull();
  });
});

describe('meta', () => {
  it('publishes no API reference', async () => {
    await expectError(await api('/v1/openapi.json'), 404, 'NOT_FOUND');
  });

  it('uses the error envelope for unknown endpoints', async () => {
    await expectError(await api('/v1/auth/login'), 404, 'NOT_FOUND');
  });
});

describe('scheduled handler', () => {
  it('runs the sweep', async () => {
    const { default: worker } = await import('../src/index');
    const share = await createShare();
    await env.DB.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, share.id).run();
    await worker.scheduled({} as ScheduledController, env);
    expect(await env.DB.prepare('SELECT id FROM shares WHERE id = ?').bind(share.id).first()).toBeNull();
  });
});

describe('free-tier budget', () => {
  it('reads spend no D1 writes on rate limiting', async () => {
    const share = await createShare();
    const ip = nextIp();
    for (let i = 0; i < 25; i += 1) await json(await api(`/v1/shares/${share.id}`, { ip }));
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE ?')
      .bind(`%:${ip}:%`)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('caps writes per address per hour', async () => {
    const share = await createShare();
    const ip = nextIp();
    const put = (version: number) =>
      api(`/v1/shares/${share.id}`, { method: 'PUT', ip, token: share.editToken, body: { ...sealed(), version } });
    for (let v = 1; v <= RATE_LIMITS.write.limit; v += 1) await json(await put(v));
    await expectError(await put(RATE_LIMITS.write.limit + 1), 429, 'RATE_LIMITED');
  }, 30_000);

  it('refuses new shares near the database size cap, with the envelope', async () => {
    const { default: worker } = await import('../src/index');
    const request = new Request('https://tallyup.test/v1/shares', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'cf-connecting-ip': nextIp(),
        'X-Tallyup-Pass': await mintPass(),
      },
      body: JSON.stringify(sealed()),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, { ...env, DB_SOFT_LIMIT_MB: '0.000001' }, ctx);
    await waitOnExecutionContext(ctx);
    await expectError(response, 503, 'AT_CAPACITY');
  });
});

describe('clientKey', () => {
  it('keeps IPv4 addresses whole', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('groups IPv6 by /64 so rotating inside a prefix does not reset limits', () => {
    expect(clientKey('2001:db8:abcd:12:1:2:3:4')).toBe('2001:db8:abcd:12::/64');
    expect(clientKey('2001:DB8:ABCD:0012::99')).toBe('2001:db8:abcd:12::/64');
    expect(clientKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
  });

  it('treats IPv4-mapped IPv6 as the IPv4 client it is', () => {
    expect(clientKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('has a key for a request with no address', () => {
    expect(clientKey(undefined)).toBe('unknown');
  });
});

describe('POST /v1/pass', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Stand in for Turnstile's siteverify so the suite never touches the network. */
  function siteverify(outcome: object) {
    const real = globalThis.fetch;
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith('https://challenges.cloudflare.com/')) return real(input, init);
      return Response.json(outcome);
    });
  }

  it('exchanges a passing Turnstile token for a day-long pass that works', async () => {
    const spy = siteverify({ success: true });
    const issued = await json(await api('/v1/pass', { body: { token: 'XXXX.DUMMY.TOKEN.XXXX' }, pass: false }));
    expect(Date.parse(issued.expiresAt)).toBeGreaterThan(Date.now() + 23 * 3600 * 1000);

    const sent = JSON.parse(String(spy.mock.calls[0][1]?.body));
    expect(sent).toMatchObject({ secret: env.TURNSTILE_SECRET, response: 'XXXX.DUMMY.TOKEN.XXXX' });

    await json(await api('/v1/shares', { body: sealed(), pass: issued.pass }), 201);
  });

  it('refuses a failed check', async () => {
    siteverify({ success: false, 'error-codes': ['invalid-input-response'] });
    await expectError(await api('/v1/pass', { body: { token: 'bad' }, pass: false }), 403, 'CHALLENGE_FAILED');
  });

  it('fails closed when siteverify is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
    await expectError(await api('/v1/pass', { body: { token: 'x' }, pass: false }), 403, 'CHALLENGE_FAILED');
  });

  it('validates the body', async () => {
    await expectError(await api('/v1/pass', { body: { token: '' }, pass: false }), 422, 'VALIDATION_ERROR');
  });
});
