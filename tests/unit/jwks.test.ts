import { generateKeyPairSync, type KeyObject } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { loadKeySet } from '../../src/auth/jwks.ts';

const first = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
const second = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
const curve = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey;

/** The public key as one entry of a JWKS. */
function entry(key: KeyObject, fields: object = {}): object {
  return { ...key.export({ format: 'jwk' }), ...fields };
}

/** An issuer that publishes a key set the test can change, and a clock the test moves. */
function issuer(keys: object[]) {
  const state = { keys, down: false, fetches: 0, time: 0 };
  const load = () =>
    loadKeySet({
      uri: 'https://fbs.example/oauth2/jwks',
      algorithm: 'RS256',
      fetchKeySet: () => {
        state.fetches += 1;
        return state.down
          ? Promise.reject(new Error('issuer down'))
          : Promise.resolve({ keys: state.keys });
      },
      now: () => state.time,
    });
  return { state, load };
}

describe('loadKeySet', () => {
  it('finds a key by the kid the token names', async () => {
    const lookup = await issuer([entry(first, { kid: 'a' }), entry(second, { kid: 'b' })]).load();

    expect((await lookup('a')).equals(first)).toBe(true);
    expect((await lookup('b')).equals(second)).toBe(true);
  });

  it('stops the start when the set cannot be fetched', async () => {
    const { state, load } = issuer([entry(first, { kid: 'a' })]);
    state.down = true;

    await expect(load()).rejects.toThrowError('issuer down');
  });

  it('stops the start when the answer is no key set', async () => {
    const lookup = loadKeySet({
      uri: 'https://fbs.example/oauth2/jwks',
      algorithm: 'RS256',
      fetchKeySet: () => Promise.resolve({ issuer: 'https://fbs.example' }),
    });

    await expect(lookup).rejects.toThrowError('answer is no key set');
  });

  it('stops the start when no key in the set fits the algorithm', async () => {
    await expect(issuer([entry(curve, { kid: 'ec' })]).load()).rejects.toThrowError(
      'no key in https://fbs.example/oauth2/jwks fits RS256',
    );
  });

  it('leaves out keys meant for encryption or for another algorithm', async () => {
    const lookup = await issuer([
      entry(first, { kid: 'enc', use: 'enc' }),
      entry(first, { kid: 'rs512', alg: 'RS512' }),
      entry(second, { kid: 'sig', use: 'sig', alg: 'RS256' }),
    ]).load();

    await expect(lookup('enc')).rejects.toThrowError('no key with kid enc');
    await expect(lookup('rs512')).rejects.toThrowError('no key with kid rs512');
    expect((await lookup('sig')).equals(second)).toBe(true);
  });

  it('loads again for an unknown kid and finds a key published since', async () => {
    const { state, load } = issuer([entry(first, { kid: 'a' })]);
    const lookup = await load();
    state.keys = [entry(first, { kid: 'a' }), entry(second, { kid: 'b' })];
    state.time += 60_000;

    expect((await lookup('b')).equals(second)).toBe(true);
    expect(state.fetches).toBe(2);
  });

  it('loads at most once a minute, however many unknown kids arrive', async () => {
    const { state, load } = issuer([entry(first, { kid: 'a' })]);
    const lookup = await load();
    state.time += 60_000;

    await expect(lookup('x')).rejects.toThrowError('no key with kid x');
    await expect(lookup('y')).rejects.toThrowError('no key with kid y');
    expect(state.fetches).toBe(2);

    state.time += 60_000;
    await expect(lookup('z')).rejects.toThrowError('no key with kid z');
    expect(state.fetches).toBe(3);
  });

  it('lets lookups that arrive together share one load', async () => {
    const { state, load } = issuer([entry(first, { kid: 'a' })]);
    const lookup = await load();
    state.keys = [entry(second, { kid: 'b' })];
    state.time += 60_000;

    const found = await Promise.all([lookup('b'), lookup('b'), lookup('b')]);

    expect(found.every((key) => key.equals(second))).toBe(true);
    expect(state.fetches).toBe(2);
  });

  it('loads an old set again, so a key the issuer withdrew stops counting', async () => {
    const { state, load } = issuer([entry(first, { kid: 'a' })]);
    const lookup = await load();
    state.keys = [entry(second, { kid: 'b' })];

    // Still young: the known key holds without asking the issuer.
    state.time += 9 * 60_000;
    expect((await lookup('a')).equals(first)).toBe(true);
    expect(state.fetches).toBe(1);

    state.time += 60_000;
    await expect(lookup('a')).rejects.toThrowError('no key with kid a');
    expect(state.fetches).toBe(2);
  });

  it('keeps the known keys while the issuer is down', async () => {
    const { state, load } = issuer([entry(first, { kid: 'a' })]);
    const lookup = await load();
    state.down = true;
    state.time += 10 * 60_000;

    expect((await lookup('a')).equals(first)).toBe(true);
    expect(state.fetches).toBe(2);
  });

  it('takes the only key for a token without kid, but guesses nothing among several', async () => {
    const single = await issuer([entry(first, { kid: 'a' })]).load();
    const several = await issuer([entry(first, { kid: 'a' }), entry(second, { kid: 'b' })]).load();

    expect((await single(undefined)).equals(first)).toBe(true);
    await expect(several(undefined)).rejects.toThrowError('token names no key');
  });
});
