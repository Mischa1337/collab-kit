import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import { createTokenCheck } from '../../src/auth/token.ts';

const secret = 'geheimnis-des-werkzeugs';
const check = createTokenCheck({ secret });

function sign(payload: object, options: jwt.SignOptions = {}): string {
  return jwt.sign(payload, secret, { algorithm: 'HS256', ...options });
}

describe('createTokenCheck', () => {
  it('takes the opaque key from sub and the display name from name', () => {
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
