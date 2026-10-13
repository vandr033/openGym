import { test } from 'node:test';
import assert from 'node:assert/strict';

function response() { return { statusCode: 0, body: null }; }

test('collaborative session routes stay inert unless both SaaS flags are enabled', async () => {
  const previousSaas = process.env.SAAS_ENABLED;
  const previousCollab = process.env.COLLAB_WORKOUTS_ENABLED;
  try {
    for (const [saas, collab, suffix] of [['0', '1', 'saas-off'], ['1', '0', 'collab-off']]) {
      process.env.SAAS_ENABLED = saas;
      process.env.COLLAB_WORKOUTS_ENABLED = collab;
      const { workoutSessionRoutes } = await import(`../saas/workout-routes.js?${suffix}`);
      let authReads = 0, dbReads = 0;
      const routes = workoutSessionRoutes({
        json: (res, status, body) => { res.statusCode = status; res.body = body; },
        readBody: async () => { throw new Error('body must not be read'); },
        readSession: () => { authReads++; return { id: 'legacy-user' }; },
        getDb: async () => { dbReads++; throw new Error('database must not be opened'); },
        legacyUserById: () => null
      });
      const res = response();
      await routes['GET /api/v2/workout-sessions/:sessionId']({ saasParams: { sessionId: 'unused' } }, res);
      assert.equal(res.statusCode, 404);
      assert.deepEqual(res.body, { error: 'not found' });
      assert.equal(authReads, 0);
      assert.equal(dbReads, 0);
    }
  } finally {
    if (previousSaas === undefined) delete process.env.SAAS_ENABLED; else process.env.SAAS_ENABLED = previousSaas;
    if (previousCollab === undefined) delete process.env.COLLAB_WORKOUTS_ENABLED; else process.env.COLLAB_WORKOUTS_ENABLED = previousCollab;
  }
});
