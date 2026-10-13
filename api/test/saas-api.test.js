import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyUidHash } from '../saas/identity.js';

process.env.SAAS_ENABLED = '1';
const { saasRoutes } = await import('../saas/routes.js?saas-api-enabled');

const legacyAdmin = { id: 'legacy-admin-id', name: 'Legacy Admin', admin: true };
const sqlAdmin = { id: 'sql-admin-id', legacyUid: legacyAdmin.id, legacyUidHash: legacyUidHash(legacyAdmin.id), displayName: legacyAdmin.name, status: 'ACTIVE' };
function response() { return { statusCode: 0, body: null }; }
function makeRoutes(db) {
  return saasRoutes({
    json: (res, statusCode, body) => { res.statusCode = statusCode; res.body = body; },
    readBody: req => req.body,
    readSession: req => req.sessionUser || null,
    getDb: async () => db,
    legacyUserById: id => id === legacyAdmin.id ? legacyAdmin : null
  });
}

test('tenant routes require an existing OpenGym session', async () => {
  let connects = 0;
  const routes = makeRoutes({ get unused() { connects++; } });
  const res = response();
  await routes['GET /api/v2/organizations/me']({}, res);
  assert.equal(res.statusCode, 401);
  assert.equal(connects, 0);
});

test('legacy admin privileges alone do not grant PlatformAdmin or reveal organizations', async () => {
  let organizationWrites = 0;
  const db = {
    user: {
      findUnique: async ({ where }) => where.legacyUidHash === sqlAdmin.legacyUidHash ? sqlAdmin : null,
      upsert: async () => sqlAdmin
    },
    platformAdmin: { findUnique: async () => null },
    organization: { create: async () => { organizationWrites++; } }
  };
  const routes = makeRoutes(db);
  const res = response();
  await routes['POST /api/v2/platform/organizations']({ sessionUser: legacyAdmin, body: {
    type: 'GYM', name: 'Private Gym', slug: 'private-gym', ownerLegacyUid: legacyAdmin.id
  } }, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'not found' });
  assert.equal(organizationWrites, 0);
});

test('cross-tenant lists and another client’s consent grant both return indistinguishable 404s', async () => {
  const sqlActor = { id: 'sql-actor', legacyUid: 'legacy-admin-id', legacyUidHash: legacyUidHash('legacy-admin-id'), displayName: legacyAdmin.name, status: 'ACTIVE' };
  let grantWrites = 0;
  const db = {
    user: { findUnique: async () => sqlActor, upsert: async () => sqlActor },
    organizationMembership: { findFirst: async () => null },
    clientOrganizationEnrollment: { findFirst: async () => null },
    trainerClientRelationship: {
      findUnique: async () => ({ id: 'relationship', organizationId: 'org', trainerUserId: 'trainer', clientUserId: 'different-client', status: 'ACTIVE' })
    },
    $transaction: async fn => fn({ clientAccessGrant: { create: async () => { grantWrites++; } } })
  };
  const routes = makeRoutes(db);
  const list = response();
  await routes['GET /api/v2/organizations/:orgId/clients']({
    sessionUser: legacyAdmin, saasParams: { orgId: '123e4567-e89b-42d3-a456-426614174000' }
  }, list);
  assert.equal(list.statusCode, 404);
  assert.deepEqual(list.body, { error: 'not found' });

  const grant = response();
  await routes['PUT /api/v2/coaching/relationships/:id/grants']({
    sessionUser: legacyAdmin,
    saasParams: { id: '123e4567-e89b-42d3-a456-426614174000' },
    body: { scopes: ['VIEW_TRAINING'], expiresAt: new Date(Date.now() + 86400000).toISOString() }
  }, grant);
  assert.equal(grant.statusCode, 404);
  assert.deepEqual(grant.body, { error: 'not found' });
  assert.equal(grantWrites, 0);
});

test('request-body parse errors keep their client status, and database failures use the scoped 503 response', async () => {
  const sqlActor = { id: 'sql-actor', legacyUid: legacyAdmin.id, legacyUidHash: legacyUidHash(legacyAdmin.id), displayName: legacyAdmin.name, status: 'ACTIVE' };
  const bodyRoutes = saasRoutes({
    json: (res, statusCode, body) => { res.statusCode = statusCode; res.body = body; },
    readBody: async () => { throw Object.assign(new Error('invalid json'), { status: 400 }); },
    readSession: req => req.sessionUser || null,
    getDb: async () => ({ user: { findUnique: async () => sqlActor, upsert: async () => sqlActor } })
  });
  const invalidBody = response();
  await bodyRoutes['PUT /api/v2/coaching/relationships/:id/grants']({
    sessionUser: legacyAdmin, saasParams: { id: '123e4567-e89b-42d3-a456-426614174000' }
  }, invalidBody);
  assert.equal(invalidBody.statusCode, 400);
  assert.deepEqual(invalidBody.body, { error: 'invalid json' });

  const unavailableRoutes = makeRoutes({ user: { findUnique: async () => { throw new Error('database down'); } } });
  const unavailable = response();
  await unavailableRoutes['GET /api/v2/organizations/me']({ sessionUser: legacyAdmin }, unavailable);
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.body, { error: 'SaaS is temporarily unavailable' });
});

test('SAAS_ENABLED=0 removes the tenant API before authentication or database access', async () => {
  process.env.SAAS_ENABLED = '0';
  const { saasRoutes: disabledRoutes } = await import('../saas/routes.js?saas-api-disabled');
  const routes = disabledRoutes({
    json: (res, statusCode, body) => { res.statusCode = statusCode; res.body = body; },
    readSession: () => null,
    getDb: async () => { throw new Error('database must not be opened'); }
  });
  const res = response();
  await routes['GET /api/v2/organizations/me']({}, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'not found' });
});
