import { ensureIdentity } from './identity.js';
import {
  WorkoutSessionError, applyWorkoutOperation, finalizeWorkoutSession,
  getActiveWorkoutSession, getWorkoutEvents, getWorkoutSession,
  parseEventLimit, startWorkoutSession, validateEventCursor
} from './workout-sessions.js';

const ENABLED = ['1', 'true'].includes(process.env.SAAS_ENABLED);
const COLLAB_ENABLED = ['1', 'true'].includes(process.env.COLLAB_WORKOUTS_ENABLED);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function notFound(json, res) { return json(res, 404, { error: 'not found' }); }

async function clientUserId(db, input, actor, legacyUser, legacyUserById) {
  if (input === legacyUser.id) return actor.id;
  if (ID.test(input)) {
    const client = await db.user.findFirst({ where: { id: input.toLowerCase(), status: 'ACTIVE' }, select: { id: true } });
    return client?.id || null;
  }
  const legacyClient = legacyUserById(input);
  if (!legacyClient || legacyClient.disabled) return null;
  const client = await ensureIdentity(db, legacyClient);
  return client?.status === 'ACTIVE' ? client.id : null;
}

export function workoutSessionRoutes({ json, readBody, readSession, getDb, legacyUserById }) {
  const active = ENABLED && COLLAB_ENABLED;
  const handle = (key, fn) => async (req, res) => {
    if (!active) return notFound(json, res);
    const legacyUser = readSession(req);
    if (!legacyUser) return json(res, 401, { error: 'not signed in' });
    try {
      const db = await getDb();
      const actor = await ensureIdentity(db, legacyUser);
      if (!actor || actor.status !== 'ACTIVE') return json(res, 403, { error: 'forbidden' });
      await fn(req, res, { db, actor, legacyUser });
    } catch (error) {
      if (error instanceof WorkoutSessionError) {
        return json(res, error.status, {
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
          ...error.details
        });
      }
      if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
        return json(res, error.status, { error: error.message });
      }
      if (error?.code === 'P2002') return json(res, 409, { error: 'conflict', code: 'CONFLICT' });
      if (error?.code === 'P2025') return notFound(json, res);
      console.error('Collaborative workout route failed', key, error?.code || error?.name || 'unknown error');
      return json(res, 503, { error: 'Collaborative workouts are temporarily unavailable' });
    }
  };

  return {
    'GET /api/v2/clients/:clientId/workout-sessions/active': handle('GET /api/v2/clients/:clientId/workout-sessions/active', async (req, res, { db, actor, legacyUser }) => {
      const clientId = await clientUserId(db, req.saasParams.clientId, actor, legacyUser, legacyUserById);
      if (!clientId) return notFound(json, res);
      json(res, 200, await getActiveWorkoutSession(db, { actorUserId: actor.id, clientUserId: clientId }));
    }),

    'POST /api/v2/clients/:clientId/workout-sessions': handle('POST /api/v2/clients/:clientId/workout-sessions', async (req, res, { db, actor, legacyUser }) => {
      const clientId = await clientUserId(db, req.saasParams.clientId, actor, legacyUser, legacyUserById);
      if (!clientId) return notFound(json, res);
      const result = await startWorkoutSession(db, { actorUserId: actor.id, clientUserId: clientId, body: await readBody(req) });
      json(res, result.statusCode, result.body);
    }),

    'GET /api/v2/workout-sessions/:sessionId': handle('GET /api/v2/workout-sessions/:sessionId', async (req, res, { db, actor }) => {
      if (!ID.test(req.saasParams.sessionId)) return notFound(json, res);
      json(res, 200, await getWorkoutSession(db, { actorUserId: actor.id, sessionId: req.saasParams.sessionId.toLowerCase() }));
    }),

    'GET /api/v2/workout-sessions/:sessionId/events': handle('GET /api/v2/workout-sessions/:sessionId/events', async (req, res, { db, actor }) => {
      if (!ID.test(req.saasParams.sessionId)) return notFound(json, res);
      const query = new URL(req.url, 'http://x').searchParams;
      json(res, 200, await getWorkoutEvents(db, {
        actorUserId: actor.id, sessionId: req.saasParams.sessionId.toLowerCase(),
        afterSequence: validateEventCursor(query.get('afterSequence')),
        limit: parseEventLimit(query.get('limit'))
      }));
    }),

    'POST /api/v2/workout-sessions/:sessionId/operations': handle('POST /api/v2/workout-sessions/:sessionId/operations', async (req, res, { db, actor }) => {
      if (!ID.test(req.saasParams.sessionId)) return notFound(json, res);
      json(res, 200, await applyWorkoutOperation(db, {
        actorUserId: actor.id, sessionId: req.saasParams.sessionId.toLowerCase(), body: await readBody(req)
      }));
    }),

    'POST /api/v2/workout-sessions/:sessionId/complete': handle('POST /api/v2/workout-sessions/:sessionId/complete', async (req, res, { db, actor }) => {
      if (!ID.test(req.saasParams.sessionId)) return notFound(json, res);
      json(res, 200, await finalizeWorkoutSession(db, {
        actorUserId: actor.id, sessionId: req.saasParams.sessionId.toLowerCase(), body: await readBody(req), status: 'COMPLETED'
      }));
    }),

    'POST /api/v2/workout-sessions/:sessionId/cancel': handle('POST /api/v2/workout-sessions/:sessionId/cancel', async (req, res, { db, actor }) => {
      if (!ID.test(req.saasParams.sessionId)) return notFound(json, res);
      json(res, 200, await finalizeWorkoutSession(db, {
        actorUserId: actor.id, sessionId: req.saasParams.sessionId.toLowerCase(), body: await readBody(req), status: 'CANCELLED'
      }));
    })
  };
}
