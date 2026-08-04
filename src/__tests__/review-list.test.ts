// T-BE-Fixes: GET /api/sessions/:id/reviews liefert jetzt feedback[]/assignees/version_number
// gebatcht mit (kein N+1). DB gemockt; Kommentar-Batch gemockt; die neuen Batch-Helfer laufen echt.
import request from 'supertest';

jest.mock('../config/db', () => ({ db: { query: jest.fn(), connect: jest.fn() }, connectDB: jest.fn() }));
jest.mock('../config/redis', () => ({
  redis: { publish: jest.fn().mockResolvedValue(1), set: jest.fn(), del: jest.fn(), getBuffer: jest.fn().mockResolvedValue(null), scan: jest.fn().mockResolvedValue(['0', []]) },
  connectRedis: jest.fn().mockResolvedValue(undefined),
  subscriber: { subscribe: jest.fn(), on: jest.fn(), unsubscribe: jest.fn() },
}));
jest.mock('../services/comments/comments.repository', () => ({
  getReviewComments: jest.fn(),
  getReviewCommentsBatch: jest.fn().mockResolvedValue(new Map([['r1', { comments: [], open_comments: 1, resolved_comments: 0 }]])),
  COMMENT_COLS: 'id, session_id, author_id, content, position, parent_id, review_id, resolved_at, resolved_by, created_at',
}));

import { app } from '../app';
import { db } from '../config/db';

const SID = 's1';
beforeEach(() => jest.clearAllMocks());

describe('GET /api/sessions/:id/reviews — angereicherte Liste (kein N+1)', () => {
  it('liefert pro Review feedback[], assignees und version_number', async () => {
    (db.query as jest.Mock)
      // 1) Haupt-Query (reviews + LEFT JOIN history)
      .mockResolvedValueOnce({ rows: [{
        id: 'r1', session_id: SID, requester_id: 'u', status: 'in_review',
        version_id: 'v1', audience: 'selected', created_at: 't', version_number: 7,
      }] })
      // 2) getFeedbackByReviewIds
      .mockResolvedValueOnce({ rows: [{ review_id: 'r1', author_id: 'bob', feedback: 'gut', verdict: 'approved', created_at: 't' }] })
      // 3) getAssigneesByReviewIds
      .mockResolvedValueOnce({ rows: [{ review_id: 'r1', user_id: 'bob' }, { review_id: 'r1', user_id: 'carol' }] });

    const res = await request(app).get(`/api/sessions/${SID}/reviews`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const r = res.body[0];
    expect(r.feedback).toHaveLength(1);
    expect(r.feedback[0]).toMatchObject({ author_id: 'bob', verdict: 'approved' });
    expect(r.assignees).toEqual(['bob', 'carol']);
    expect(r.version_number).toBe(7);
    expect(r.open_comments).toBe(1);
  });

  it('leere Session → leere Liste, ohne Folgequeries', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] }); // Haupt-Query leer
    const res = await request(app).get(`/api/sessions/${SID}/reviews`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
