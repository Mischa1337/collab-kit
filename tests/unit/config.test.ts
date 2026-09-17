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
      port: 3000,
      logLevel: 'info',
      mongoUri: valid.MONGODB_URI,
      mongoDb: valid.MONGODB_DB,
      jwtSecret: valid.JWT_SECRET,
    });
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
