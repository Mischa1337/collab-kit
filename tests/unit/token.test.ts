import { generateKeyPairSync } from 'node:crypto';

import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import { loadKeySet } from '../../src/auth/jwks.ts';
import { createTokenCheck } from '../../src/auth/token.ts';

const secret = 'geheimnis-des-werkzeugs';
const check = createTokenCheck({ key: secret });

function sign(payload: object, options: jwt.SignOptions = {}): string {
  return jwt.sign(payload, secret, { algorithm: 'HS256', ...options });
}

describe('createTokenCheck', () => {
  it('by default takes the opaque key from sub and the display name from name', async () => {
    const token = sign({ sub: 'u-8134', name: 'Alice Muster' }, { expiresIn: '15m' });

    await expect(check(token)).resolves.toEqual({ actorId: 'u-8134', label: 'Alice Muster' });
  });

  it('accepts a token without a name and then carries no label', async () => {
    await expect(check(sign({ sub: 'u-8134' }, { expiresIn: '15m' }))).resolves.toEqual({
      actorId: 'u-8134',
    });
  });

  it('ignores every other claim, roles of the tool included', async () => {
    const token = sign({ sub: 'u-8134', role: 'lecturer', tenant: 'x' }, { expiresIn: '15m' });

    await expect(check(token)).resolves.toEqual({ actorId: 'u-8134' });
  });

  it('refuses a signature made with another secret', async () => {
    const foreign = jwt.sign({ sub: 'u-8134' }, 'anderes-geheimnis', { expiresIn: '15m' });

    await expect(check(foreign)).rejects.toThrowError('token rejected');
  });

  it('refuses an expired token, once it is past the clock tolerance', async () => {
    // Five seconds of tolerance are allowed, so -1s would still pass.
    await expect(check(sign({ sub: 'u-8134' }, { expiresIn: '-10s' }))).rejects.toThrowError(
      'token rejected',
    );
  });

  it('forgives a token that expired within the clock tolerance', async () => {
    await expect(check(sign({ sub: 'u-8134' }, { expiresIn: '-1s' }))).resolves.toEqual({
      actorId: 'u-8134',
    });
  });

  it('forgives nothing once the tolerance is set to 0', async () => {
    const strict = createTokenCheck({ key: secret, clockToleranceSeconds: 0 });

    await expect(strict(sign({ sub: 'u-8134' }, { expiresIn: '-1s' }))).rejects.toThrowError(
      'token rejected',
    );
  });

  it('refuses a token without sub, because there would be nobody to attribute to', async () => {
    await expect(check(sign({ name: 'Alice' }, { expiresIn: '15m' }))).rejects.toThrowError(
      'token rejected',
    );
  });

  it('refuses another algorithm even when the signature fits', async () => {
    const token = jwt.sign({ sub: 'u-8134' }, secret, { algorithm: 'HS512', expiresIn: '15m' });

    await expect(check(token)).rejects.toThrowError('token rejected');
  });

  it('takes over a long life the tool decided on', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = sign({ sub: 'u-8134', iat: now - 7200, exp: now + 31_536_000 });

    await expect(check(token)).resolves.toEqual({ actorId: 'u-8134' });
  });

  it('keeps the reason in cause, so only the log learns it', async () => {
    const error = await check('gar-kein-token').catch((rejected: unknown) => rejected);

    expect((error as Error).message).toBe('token rejected');
    expect((error as Error).cause).toBeDefined();
  });
});

describe('createTokenCheck with claims set for the instance', () => {
  const custom = createTokenCheck({ key: secret, actorClaim: 'uid', labelClaim: 'displayName' });

  it('takes key and name from the set claims and ignores sub', async () => {
    const token = sign(
      { sub: 'same-for-everyone', uid: 'u-8134', displayName: 'Alice Muster' },
      { expiresIn: '15m' },
    );

    await expect(custom(token)).resolves.toEqual({ actorId: 'u-8134', label: 'Alice Muster' });
  });

  it('turns a numeric key into text', async () => {
    await expect(custom(sign({ uid: 8134 }, { expiresIn: '15m' }))).resolves.toEqual({
      actorId: '8134',
    });
  });

  it('refuses a token without the set claim, even when sub is there', async () => {
    await expect(custom(sign({ sub: 'u-8134' }, { expiresIn: '15m' }))).rejects.toThrowError(
      'token rejected',
    );
  });

  it('refuses a key that is neither text nor a number', async () => {
    await Promise.all(
      [true, ['u-8134'], { value: 'u-8134' }, '  '].map((uid) =>
        expect(custom(sign({ uid }, { expiresIn: '15m' }))).rejects.toThrowError('token rejected'),
      ),
    );
  });
});

describe('createTokenCheck with the algorithm set for the instance', () => {
  it('accepts HS512 once it is set and then refuses HS256', async () => {
    const hs512 = createTokenCheck({ key: secret, algorithm: 'HS512' });

    await expect(
      hs512(sign({ sub: 'u-8134' }, { algorithm: 'HS512', expiresIn: '15m' })),
    ).resolves.toEqual({
      actorId: 'u-8134',
    });
    await expect(hs512(sign({ sub: 'u-8134' }, { expiresIn: '15m' }))).rejects.toThrowError(
      'token rejected',
    );
  });

  describe('with the public key of the tool', () => {
    const tool = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKey = tool.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const rs256 = createTokenCheck({ key: publicKey, algorithm: 'RS256' });

    it('accepts a token the tool signed with its private key', async () => {
      const token = jwt.sign({ sub: 'u-8134' }, tool.privateKey, {
        algorithm: 'RS256',
        expiresIn: '15m',
      });

      await expect(rs256(token)).resolves.toEqual({ actorId: 'u-8134' });
    });

    it('refuses a token signed with another private key', async () => {
      const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const token = jwt.sign({ sub: 'u-8134' }, stranger.privateKey, {
        algorithm: 'RS256',
        expiresIn: '15m',
      });

      await expect(rs256(token)).rejects.toThrowError('token rejected');
    });

    it('refuses an HS256 token that uses the public key as its secret', async () => {
      // The public key is known to anyone, so a token signed with it proves nothing.
      const forged = jwt.sign({ sub: 'mallory' }, publicKey, {
        algorithm: 'HS256',
        expiresIn: '15m',
      });

      await expect(rs256(forged)).rejects.toThrowError('token rejected');
    });

    it('fails at creation when the key is no public key', () => {
      expect(() => createTokenCheck({ key: 'kein-schluessel', algorithm: 'RS256' })).toThrow();
    });
  });
});

describe('createTokenCheck with issuer and audience set for the instance', () => {
  const bound = createTokenCheck({
    key: secret,
    issuer: 'https://fbs.example',
    audience: ['fbs-web-shell', 'fbs-test-client'],
  });

  it('accepts the expected issuer and one of the expected audiences', async () => {
    const token = sign(
      { sub: 'u-8134', iss: 'https://fbs.example', aud: ['fbs-test-client'] },
      { expiresIn: '15m' },
    );

    await expect(bound(token)).resolves.toEqual({ actorId: 'u-8134' });
  });

  it('refuses a token from another issuer', async () => {
    const token = sign(
      { sub: 'u-8134', iss: 'https://other.example', aud: 'fbs-web-shell' },
      { expiresIn: '15m' },
    );

    await expect(bound(token)).rejects.toThrowError('token rejected');
  });

  it('refuses a token meant for another application', async () => {
    const token = sign(
      { sub: 'u-8134', iss: 'https://fbs.example', aud: 'some-other-tool' },
      { expiresIn: '15m' },
    );

    await expect(bound(token)).rejects.toThrowError('token rejected');
  });

  it('refuses a token that names neither issuer nor audience', async () => {
    await expect(bound(sign({ sub: 'u-8134' }, { expiresIn: '15m' }))).rejects.toThrowError(
      'token rejected',
    );
  });

  it('checks neither as long as they are not set', async () => {
    const token = sign(
      { sub: 'u-8134', iss: 'https://other.example', aud: 'some-other-tool' },
      { expiresIn: '15m' },
    );

    await expect(check(token)).resolves.toEqual({ actorId: 'u-8134' });
  });
});

describe('createTokenCheck with the key set of the tool', () => {
  const tool = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...tool.publicKey.export({ format: 'jwk' }), kid: 'fbs-key' };
  let fetches = 0;
  let time = 0;

  const keySet = loadKeySet({
    uri: 'https://fbs.example/oauth2/jwks',
    algorithm: 'RS256',
    fetchKeySet: () => {
      fetches += 1;
      return Promise.resolve({ keys: [jwk] });
    },
    now: () => time,
  });

  function signRs256(payload: object, keyid: string): string {
    return jwt.sign(payload, tool.privateKey, { algorithm: 'RS256', keyid, expiresIn: '15m' });
  }

  it('accepts a token signed with the key its kid names', async () => {
    const rs256 = createTokenCheck({ key: await keySet, algorithm: 'RS256', actorClaim: 'id' });

    await expect(rs256(signRs256({ id: 42 }, 'fbs-key'))).resolves.toEqual({ actorId: '42' });
  });

  it('refuses a token whose kid is in no set, even after loading it again', async () => {
    const rs256 = createTokenCheck({ key: await keySet, algorithm: 'RS256' });
    time += 60_000;

    await expect(rs256(signRs256({ sub: 'u-8134' }, 'unknown'))).rejects.toThrowError(
      'token rejected',
    );
  });

  it('refuses a foreign algorithm before it would load the set again', async () => {
    const rs256 = createTokenCheck({ key: await keySet, algorithm: 'RS256' });
    const forged = jwt.sign({ sub: 'mallory' }, 'erraten', { algorithm: 'HS256', keyid: 'new' });
    time += 60_000;
    const before = fetches;

    await expect(rs256(forged)).rejects.toThrowError('token rejected');
    expect(fetches).toBe(before);
  });
});
