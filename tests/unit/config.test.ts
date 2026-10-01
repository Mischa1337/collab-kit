import { describe, expect, it } from 'vitest';

import { readConfig } from '../../src/config.ts';

const valid = {
  MONGODB_URI: 'mongodb://localhost:27017/?replicaSet=rs0',
  MONGODB_DB: 'collab_kit',
  JWT_SECRET: 'local-secret',
};

describe('readConfig', () => {
  it('fills in the defaults for the optional variables', () => {
    const config = readConfig(valid);

    expect(config).toEqual({
      nodeEnv: 'development',
      port: 24202,
      logLevel: 'info',
      mongoUri: valid.MONGODB_URI,
      mongoDb: valid.MONGODB_DB,
      jwtAlgorithm: 'HS256',
      jwtKey: valid.JWT_SECRET,
      jwtClockTolerance: 5,
      actorClaim: 'sub',
      labelClaim: 'name',
    });
  });

  it('lets the operator lower the clock tolerance down to 0', () => {
    expect(readConfig({ ...valid, JWT_CLOCK_TOLERANCE: '0' })).toMatchObject({
      jwtClockTolerance: 0,
    });
  });

  it('takes a message limit below what MongoDB keeps in one document', () => {
    expect(readConfig({ ...valid, MAX_MESSAGE_BYTES: '1048576' })).toMatchObject({
      maxMessageBytes: 1_048_576,
    });
    for (const raw of ['0', '1.5', 'viel', String(16 * 1024 * 1024)]) {
      expect(() => readConfig({ ...valid, MAX_MESSAGE_BYTES: raw })).toThrowError(
        /MAX_MESSAGE_BYTES must be whole bytes from 1 to 15 MiB/,
      );
    }
  });

  it('takes an awareness limit by the same rule', () => {
    expect(readConfig({ ...valid, MAX_AWARENESS_BYTES: '4096' })).toMatchObject({
      maxAwarenessBytes: 4096,
    });
    expect(() => readConfig({ ...valid, MAX_AWARENESS_BYTES: '-1' })).toThrowError(
      /MAX_AWARENESS_BYTES must be whole bytes from 1 to 15 MiB/,
    );
  });

  it('reads the allowed origins as a list and refuses one a browser never sends', () => {
    expect(
      readConfig({ ...valid, ALLOWED_ORIGINS: 'https://tool.example, http://localhost:5173' }),
    ).toMatchObject({ allowedOrigins: ['https://tool.example', 'http://localhost:5173'] });
    expect(readConfig({ ...valid, ALLOWED_ORIGINS: ' , ' })).not.toHaveProperty('allowedOrigins');
    for (const raw of ['https://tool.example/', 'tool.example', 'https://tool.example/app']) {
      expect(() => readConfig({ ...valid, ALLOWED_ORIGINS: raw })).toThrowError(
        /ALLOWED_ORIGINS must list origins like https:\/\/tool.example/,
      );
    }
  });

  it('rejects a clock tolerance that is not whole seconds from 0', () => {
    for (const raw of ['-1', '1.5', 'five']) {
      expect(() => readConfig({ ...valid, JWT_CLOCK_TOLERANCE: raw })).toThrowError(
        /JWT_CLOCK_TOLERANCE must be whole seconds from 0/,
      );
    }
  });

  it('takes the public key instead of the secret for an asymmetric algorithm', () => {
    const config = readConfig({ ...valid, JWT_ALGORITHM: 'RS256', JWT_PUBLIC_KEY: 'pem' });

    expect(config).toMatchObject({ jwtAlgorithm: 'RS256', jwtKey: 'pem' });
  });

  it('requires JWT_PUBLIC_KEY for an asymmetric algorithm', () => {
    expect(() => readConfig({ ...valid, JWT_ALGORITHM: 'ES256' })).toThrowError(
      /JWT_PUBLIC_KEY is missing/,
    );
  });

  it('rejects an unknown algorithm, none included', () => {
    expect(() => readConfig({ ...valid, JWT_ALGORITHM: 'none' })).toThrowError(
      /JWT_ALGORITHM must be one of/,
    );
  });

  it('takes the claims a tool uses instead of the standard ones', () => {
    const config = readConfig({ ...valid, ACTOR_CLAIM: ' uid ', LABEL_CLAIM: 'displayName' });

    expect(config).toMatchObject({ actorClaim: 'uid', labelClaim: 'displayName' });
  });

  it('treats blank claim variables as not set', () => {
    const config = readConfig({ ...valid, ACTOR_CLAIM: '', LABEL_CLAIM: '   ' });

    expect(config).toMatchObject({ actorClaim: 'sub', labelClaim: 'name' });
  });

  it('reports every missing variable at once instead of the first one', () => {
    expect(() => readConfig({})).toThrowError(
      /MONGODB_URI is missing[\s\S]*MONGODB_DB is missing[\s\S]*JWT_SECRET is missing/,
    );
  });

  it('rejects a port that is not a port number', () => {
    expect(() => readConfig({ ...valid, PORT: 'http' })).toThrowError(/PORT must be a port number/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => readConfig({ ...valid, NODE_ENV: 'staging' })).toThrowError(
      /NODE_ENV must be one/,
    );
  });

  it('rejects the example secret in production', () => {
    expect(() =>
      readConfig({ ...valid, NODE_ENV: 'production', JWT_SECRET: 'replace-me-locally' }),
    ).toThrowError(/JWT_SECRET still holds the example placeholder/);
  });
});
