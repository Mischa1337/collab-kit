import { Router } from 'express';
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createServer } from '../../src/routes/server.ts';

const silent = pino({ level: 'silent' });
const server = createServer({ logger: silent });

describe('createServer', () => {
  it('answers the health check', async () => {
    const response = await request(server).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('carries no routes of the service without an api', async () => {
    expect((await request(server).get('/rooms/abc')).status).toBe(404);
  });

  it('answers a failing route without telling what broke', async () => {
    const api = Router();
    api.get('/boom', () => {
      throw new Error('the reason nobody outside may read');
    });

    const response = await request(createServer({ logger: silent, api })).get('/boom');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'internal' });
  });

  it('answers a rejected promise the same way', async () => {
    const api = Router();
    api.get('/boom', async () => {
      await Promise.reject(new Error('rejected instead of thrown'));
    });

    expect((await request(createServer({ logger: silent, api })).get('/boom')).status).toBe(500);
  });

  it('does not announce which server it is', async () => {
    const response = await request(server).get('/health');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
