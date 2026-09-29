import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { requireActor } from '../../src/auth/middleware.ts';
import { createTokenCheck } from '../../src/auth/token.ts';

const secret = 'geheimnis-des-werkzeugs';

const app = express();
app.get('/probe', requireActor(createTokenCheck({ key: secret })), (req, res) => {
  res.json(req.actor);
});

const token = jwt.sign({ sub: 'u-8134', name: 'Alice Muster' }, secret, { expiresIn: '15m' });

describe('requireActor', () => {
  it('hands the actor to the route behind it', async () => {
    const response = await request(app).get('/probe').set('authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ actorId: 'u-8134', label: 'Alice Muster' });
  });

  it('refuses a request without a header', async () => {
    const response = await request(app).get('/probe');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized' });
  });

  it('refuses a scheme other than Bearer', async () => {
    const response = await request(app).get('/probe').set('authorization', `Basic ${token}`);

    expect(response.status).toBe(401);
  });

  it('answers a broken token exactly like a missing one', async () => {
    const broken = await request(app).get('/probe').set('authorization', 'Bearer kaputt');
    const missing = await request(app).get('/probe');

    expect(broken.status).toBe(missing.status);
    expect(broken.body).toEqual(missing.body);
  });

  it('passes the reason on for the log without answering with it', async () => {
    const reasons: unknown[] = [];
    const logging = express();
    logging.get(
      '/probe',
      requireActor(createTokenCheck({ key: secret }), (error) => reasons.push(error)),
      (req, res) => res.json(req.actor),
    );

    const response = await request(logging).get('/probe').set('authorization', 'Bearer kaputt');

    expect(response.body).toEqual({ error: 'unauthorized' });
    expect(reasons).toHaveLength(1);
  });
});
