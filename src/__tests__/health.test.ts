// M20 — Health / Readiness / Metrics Tests
// DB und Redis werden gemockt — kein laufender Docker nötig.
import request from 'supertest';
import { db } from '../config/db';
import { redis } from '../config/redis';

jest.mock('../config/db', () => {
  const mockQuery = jest.fn();
  return {
    db: {
      query: mockQuery,
      connect: jest.fn().mockImplementation(() =>
        Promise.resolve({ query: mockQuery, release: jest.fn() })
      ),
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
    },
    connectDB: jest.fn(),
  };
});

jest.mock('../config/redis', () => ({
  redis: {
    ping: jest.fn(),
    del: jest.fn().mockResolvedValue(1),
    publish: jest.fn().mockResolvedValue(1),
  },
  connectRedis: jest.fn().mockResolvedValue(undefined),
  subscriber: {
    subscribe: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    unsubscribe: jest.fn(),
  },
}));

import { app } from '../app';

beforeEach(() => jest.clearAllMocks());

describe('M20 — Health / Readiness', () => {
  it('GET /health → 200 ok (Liveness, ohne Abhängigkeiten)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /health → enthält gültigen ISO-Timestamp', async () => {
    const res = await request(app).get('/health');
    expect(res.body).toHaveProperty('timestamp');
    expect(new Date(res.body.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('GET /health → ohne Authentifizierung erreichbar', async () => {
    const res = await request(app).get('/health');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('GET /ready → 200 wenn DB und Redis erreichbar', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ ok: 1 }] });
    (redis.ping as jest.Mock).mockResolvedValueOnce('PONG');
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  it('GET /ready → prüft die DB mit SELECT 1', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ ok: 1 }] });
    (redis.ping as jest.Mock).mockResolvedValueOnce('PONG');
    await request(app).get('/ready');
    expect(db.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('GET /ready → ohne Authentifizierung erreichbar', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ ok: 1 }] });
    (redis.ping as jest.Mock).mockResolvedValueOnce('PONG');
    const res = await request(app).get('/ready');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  // Abnahmekriterium M20: /ready meldet 503, wenn DB oder Redis nicht erreichbar ist.
  it('GET /ready → 503 wenn die DB nicht erreichbar ist', async () => {
    (db.query as jest.Mock).mockRejectedValueOnce(new Error('DB down'));
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
  });

  it('GET /ready → 503 wenn Redis nicht erreichbar ist', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ ok: 1 }] });
    (redis.ping as jest.Mock).mockRejectedValueOnce(new Error('Redis down'));
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
  });
});

describe('M20 — /metrics Zugriffsschutz (METRICS_TOKEN)', () => {
  const OLD_TOKEN = process.env.METRICS_TOKEN;
  beforeAll(() => { process.env.METRICS_TOKEN = 'secret-123'; });
  afterAll(() => { process.env.METRICS_TOKEN = OLD_TOKEN; });

  it('403 ohne Token', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(403);
  });

  it('403 mit falschem Token', async () => {
    const res = await request(app).get('/metrics').set('Authorization', 'Bearer falsch');
    expect(res.status).toBe(403);
  });

  it('200 + Prometheus-Metriken mit korrektem Bearer-Token', async () => {
    const res = await request(app).get('/metrics').set('Authorization', 'Bearer secret-123');
    expect(res.status).toBe(200);
    expect(res.text).toContain('coworking_active_sessions');
    expect(res.text).toContain('coworking_ws_connections');
    expect(res.text).toContain('coworking_db_pool_total');
    expect(res.text).toContain('coworking_db_pool_idle');
    expect(res.text).toContain('coworking_db_pool_waiting');
  });

  it('200 auch via ?token= Query-Parameter (für Prometheus-Scrape-Config)', async () => {
    const res = await request(app).get('/metrics?token=secret-123');
    expect(res.status).toBe(200);
  });
});
