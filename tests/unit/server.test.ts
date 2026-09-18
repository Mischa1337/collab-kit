import pino from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createServer } from '../../src/server.ts';

const server = createServer({ logger: pino({ level: 'silent' }) });

describe('createServer', () => {
  it('answers the health check', async () => {
    const response = await request(server).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('carries no routes of the service yet', async () => {
    expect((await request(server).get('/rooms')).status).toBe(404);
  });

  it('does not announce which server it is', async () => {
    const response = await request(server).get('/health');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
