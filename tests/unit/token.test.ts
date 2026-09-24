import { generateKeyPairSync } from 'node:crypto';

import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import { createTokenCheck } from '../../src/auth/token.ts';

const secret = 'geheimnis-des-werkzeugs';
const check = createTokenCheck({ key: secret });

function sign(payload: object, options: jwt.SignOptions = {}): string {
  return jwt.sign(payload, secret, { algorithm: 'HS256', ...options });
}

describe('createTokenCheck', () => {
  it('by default takes the opaque key from sub and the display name from name', () => {
    const token = sign({ sub: 'u-8134', name: 'Alice Muster' }, { expiresIn: '15m' });

    expect(check(token)).toEqual({ actorId: 'u-8134', label: 'Alice Muster' });
  });

  it('accepts a token without a name and then carries no label', () => {
    expect(check(sign({ sub: 'u-8134' }, { expiresIn: '15m' }))).toEqual({ actorId: 'u-8134' });
  });

  it('ignores every other claim, roles of the tool included', () => {
    const token = sign({ sub: 'u-8134', role: 'lecturer', tenant: 'x' }, { expiresIn: '15m' });

    expect(check(token)).toEqual({ actorId: 'u-8134' });
  });

  it('refuses a signature made with another secret', () => {
    const foreign = jwt.sign({ sub: 'u-8134' }, 'anderes-geheimnis', { expiresIn: '15m' });

    expect(() => check(foreign)).toThrowError('token rejected');
  });

  it('refuses an expired token, once it is past the clock tolerance', () => {
    // Five seconds of tolerance are allowed, so -1s would still pass.
    expect(() => check(sign({ sub: 'u-8134' }, { expiresIn: '-10s' }))).toThrowError(
      'token rejected',
    );
  });

  it('forgives a token that expired within the clock tolerance', () => {
    expect(check(sign({ sub: 'u-8134' }, { expiresIn: '-1s' }))).toEqual({ actorId: 'u-8134' });
  });

  it('forgives nothing once the tolerance is set to 0', () => {
    const strict = createTokenCheck({ key: secret, clockToleranceSeconds: 0 });

    expect(() => strict(sign({ sub: 'u-8134' }, { expiresIn: '-1s' }))).toThrowError(
      'token rejected',
    );
  });

  it('refuses a token without sub, because there would be nobody to attribute to', () => {
    expect(() => check(sign({ name: 'Alice' }, { expiresIn: '15m' }))).toThrowError(
      'token rejected',
    );
  });

  it('refuses another algorithm even when the signature fits', () => {
    const token = jwt.sign({ sub: 'u-8134' }, secret, { algorithm: 'HS512', expiresIn: '15m' });

    expect(() => check(token)).toThrowError('token rejected');
  });

  it('takes over a long life the tool decided on', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = sign({ sub: 'u-8134', iat: now - 7200, exp: now + 31_536_000 });

    expect(check(token)).toEqual({ actorId: 'u-8134' });
  });

  it('keeps the reason in cause, so only the log learns it', () => {
    try {
      check('gar-kein-token');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toBe('token rejected');
      expect((error as Error).cause).toBeDefined();
    }
  });
});

describe('createTokenCheck with claims set for the instance', () => {
  const custom = createTokenCheck({ key: secret, actorClaim: 'uid', labelClaim: 'displayName' });

  it('takes key and name from the set claims and ignores sub', () => {
    const token = sign(
      { sub: 'same-for-everyone', uid: 'u-8134', displayName: 'Alice Muster' },
      { expiresIn: '15m' },
    );

    expect(custom(token)).toEqual({ actorId: 'u-8134', label: 'Alice Muster' });
  });

  it('turns a numeric key into text', () => {
    expect(custom(sign({ uid: 8134 }, { expiresIn: '15m' }))).toEqual({ actorId: '8134' });
  });

  it('refuses a token without the set claim, even when sub is there', () => {
    expect(() => custom(sign({ sub: 'u-8134' }, { expiresIn: '15m' }))).toThrowError(
      'token rejected',
    );
  });

  it('refuses a key that is neither text nor a number', () => {
    for (const uid of [true, ['u-8134'], { value: 'u-8134' }, '  ']) {
      expect(() => custom(sign({ uid }, { expiresIn: '15m' }))).toThrowError('token rejected');
    }
  });
});

describe('createTokenCheck with the algorithm set for the instance', () => {
  it('accepts HS512 once it is set and then refuses HS256', () => {
    const hs512 = createTokenCheck({ key: secret, algorithm: 'HS512' });

    expect(hs512(sign({ sub: 'u-8134' }, { algorithm: 'HS512', expiresIn: '15m' }))).toEqual({
      actorId: 'u-8134',
    });
    expect(() => hs512(sign({ sub: 'u-8134' }, { expiresIn: '15m' }))).toThrowError(
      'token rejected',
    );
  });

  describe('with the public key of the tool', () => {
    const tool = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKey = tool.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const rs256 = createTokenCheck({ key: publicKey, algorithm: 'RS256' });

    it('accepts a token the tool signed with its private key', () => {
      const token = jwt.sign({ sub: 'u-8134' }, tool.privateKey, {
        algorithm: 'RS256',
        expiresIn: '15m',
      });

      expect(rs256(token)).toEqual({ actorId: 'u-8134' });
    });

    it('refuses a token signed with another private key', () => {
      const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const token = jwt.sign({ sub: 'u-8134' }, stranger.privateKey, {
        algorithm: 'RS256',
        expiresIn: '15m',
      });

      expect(() => rs256(token)).toThrowError('token rejected');
    });

    it('refuses an HS256 token that uses the public key as its secret', () => {
      // The public key is known to anyone, so a token signed with it proves nothing.
      const forged = jwt.sign({ sub: 'mallory' }, publicKey, {
        algorithm: 'HS256',
        expiresIn: '15m',
      });

      expect(() => rs256(forged)).toThrowError('token rejected');
    });

    it('fails at creation when the key is no public key', () => {
      expect(() => createTokenCheck({ key: 'kein-schluessel', algorithm: 'RS256' })).toThrow();
    });
  });
});
