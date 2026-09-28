import express, { Router } from 'express';
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
    const response = await request(server).get('/rooms/abc');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'unknown route' });
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

  it('writes the reason of a failure to the log', async () => {
    const lines: string[] = [];
    const logger = pino({ level: 'error' }, { write: (line: string) => lines.push(line) });
    const api = Router();
    api.get('/boom', () => {
      throw new Error('the reason nobody outside may read');
    });

    await request(createServer({ logger, api })).get('/boom');

    expect(lines.join('')).toContain('the reason nobody outside may read');
  });

  it('keeps the status of what the client got wrong', async () => {
    const api = Router();
    api.use(express.json({ limit: '20b' }));
    api.post('/things', (_request, response) => {
      response.json({});
    });
    api.get('/things/:id', (_request, response) => {
      response.json({});
    });
    const strict = createServer({ logger: silent, api });
    const post = (body: string) =>
      request(strict).post('/things').set('Content-Type', 'application/json').send(body);

    const malformed = await post('{nope');
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: 'bad request' });

    expect((await post(JSON.stringify({ text: 'far too long for the limit' }))).status).toBe(413);
    expect((await request(strict).get('/things/%E0%A4%A')).status).toBe(400);
  });

  it('does not announce which server it is', async () => {
    const response = await request(server).get('/health');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
