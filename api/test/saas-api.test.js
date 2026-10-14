import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyUidHash } from '../saas/identity.js';

process.env.SAAS_ENABLED = '1';
process.env.SAAS_INVITES_V2_ENABLED = '1';
process.env.SAAS_EMAIL_OTP_ENABLED = '1';
const { saasRoutes } = await import('../saas/routes.js?saas-api-enabled');

const legacyAdmin = { id: 'legacy-admin-id', name: 'Legacy Admin', admin: true };
const sqlAdmin = { id: 'sql-admin-id', legacyUid: legacyAdmin.id, legacyUidHash: legacyUidHash(legacyAdmin.id), displayName: legacyAdmin.name, status: 'ACTIVE' };
function response() { return { statusCode: 0, body: null }; }
function makeRoutes(db, { emailDelivery, secret = 'test-invitation-secret' } = {}) {
  return saasRoutes({
    json: (res, statusCode, body) => { res.statusCode = statusCode; res.body = body; },
    readBody: req => req.body,
    readSession: req => req.sessionUser || null,
    getDb: async () => db,
    legacyUserById: id => id === legacyAdmin.id ? legacyAdmin : null,
    emailDelivery, secret
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

test('PlatformAdmin directory returns aggregate counts and owner invitation status without client identities', async () => {
  const org = {
    id: 'org-id', type: 'TRAINER_BUSINESS', name: 'Ari Coaching', slug: 'ari-coaching', status: 'ACTIVE', createdAt: new Date('2026-01-01T00:00:00Z'),
    memberships: [{ userId: 'trainer-user', role: 'OWNER', user: { displayName: 'Ari', verifiedEmail: { email: 'ari@example.com' } } }],
    invitations: [{ id: 'owner-invite', role: 'OWNER', targetEmail: 'owner@example.com', expiresAt: new Date(Date.now() + 86400000), acceptedAt: null, revokedAt: null, deliveryStatus: 'ACCEPTED', createdByPlatformAdmin: true }],
    _count: { enrollments: 2, invitations: 1 }
  };
  const db = {
    user: { findUnique: async () => sqlAdmin, upsert: async () => sqlAdmin },
    platformAdmin: { findUnique: async () => ({ userId: sqlAdmin.id }) },
    organization: { findMany: async () => [org] },
    clientOrganizationEnrollment: { findMany: async () => [{ clientUserId: 'client-a' }, { clientUserId: 'client-a' }, { clientUserId: 'client-b' }] }
  };
  const res = response();
  await makeRoutes(db)['GET /api/v2/platform/organizations']({ sessionUser: legacyAdmin }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.summary, { gyms: 0, trainerBusinesses: 1, trainers: 1, clients: 2, pendingInvitations: 1 });
  assert.deepEqual(res.body.organizations[0].owners, [{ userId: 'trainer-user', displayName: 'Ari', email: 'ari@example.com' }]);
  assert.equal(res.body.organizations[0].invitations[0].status, 'PENDING');
  assert.equal(res.body.organizations[0].counts.clients, 2);
  assert.doesNotMatch(JSON.stringify(res.body), /client-a|client-b|private workout|tokenHash/);
});

test('ordinary users cannot query the platform directory', async () => {
  let directoryReads = 0;
  const db = {
    user: { findUnique: async () => sqlAdmin, upsert: async () => sqlAdmin },
    platformAdmin: { findUnique: async () => null },
    organization: { findMany: async () => { directoryReads++; return []; } }
  };
  const res = response();
  await makeRoutes(db)['GET /api/v2/platform/organizations']({ sessionUser: legacyAdmin }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(directoryReads, 0);
});

test('PlatformAdmin can rotate an expired owner invitation and the action is audited', async () => {
  const orgId = '123e4567-e89b-42d3-a456-426614174000';
  const invitationId = '123e4567-e89b-42d3-a456-426614174001';
  const org = { id: orgId, name: 'Ari Coaching' };
  const invitation = {
    id: invitationId, organizationId: orgId, type: 'MEMBERSHIP', role: 'OWNER', createdByPlatformAdmin: true,
    targetEmail: 'owner@example.com', acceptedAt: null, revokedAt: null, expiresAt: new Date(Date.now() - 86400000)
  };
  const audit = [];
  const db = {
    user: { findUnique: async () => sqlAdmin, upsert: async () => sqlAdmin },
    platformAdmin: { findUnique: async () => ({ userId: sqlAdmin.id }) },
    organization: { findUnique: async () => org },
    organizationInvitation: { findFirst: async () => invitation },
    $transaction: async fn => fn({
      organizationInvitation: {
        findFirst: async ({ where }) => where.invitationCodeHash ? null : invitation,
        update: async ({ data }) => Object.assign({}, invitation, data)
      },
      auditEvent: { create: async event => { audit.push(event.data); return event.data } }
    })
  };
  const routes = makeRoutes(db, { emailDelivery: { configured: true } });
  const res = response();
  await routes['POST /api/v2/platform/organizations/:orgId/invitations/:invitationId/resend']({
    sessionUser: legacyAdmin, saasParams: { orgId, invitationId }, body: { sendEmail: false }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.token, /^[A-Za-z0-9_-]{40,50}$/);
  assert.equal(res.body.code.length, 6);
  assert.ok(new Date(res.body.invitation.expiresAt) > new Date());
  assert.equal(audit[0].action, 'invitation.resent');
  assert.equal(audit[0].metadata.platformManaged, true);
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

test('client details show relationship status to managers and expose scopes only to the assigned trainer', async () => {
  const orgId = '123e4567-e89b-42d3-a456-426614174000';
  const relationship = {
    id: 'relationship-id', organizationId: orgId, trainerUserId: 'assigned-trainer', clientUserId: 'client-id', status: 'ACTIVE',
    trainer: { displayName: 'Coach' }, grants: [{ scope: 'VIEW_BODYWEIGHT', expiresAt: new Date(Date.now() + 86400000) }]
  };
  const routeFor = role => makeRoutes({
    user: { findUnique: async () => sqlAdmin, upsert: async () => sqlAdmin },
    organizationMembership: { findFirst: async () => ({ role }) },
    clientOrganizationEnrollment: {
      findMany: async () => [{ clientUserId: 'client-id', client: { id: 'client-id', displayName: 'Client' } }]
    },
    trainerClientRelationship: { findMany: async () => [relationship] }
  })['GET /api/v2/organizations/:orgId/clients'];

  const manager = response();
  await routeFor('ADMIN')({ sessionUser: legacyAdmin, saasParams: { orgId } }, manager);
  assert.equal(manager.statusCode, 200);
  assert.equal(manager.body.clients[0].relationshipStatus, 'ACTIVE');
  assert.equal(manager.body.clients[0].relationships[0].trainerName, 'Coach');
  assert.equal(JSON.stringify(manager.body).includes('VIEW_BODYWEIGHT'), false);

  const trainer = response();
  const trainerRelationship = { ...relationship, trainerUserId: sqlAdmin.id };
  const trainerRoute = makeRoutes({
    user: { findUnique: async () => sqlAdmin, upsert: async () => sqlAdmin },
    organizationMembership: { findFirst: async () => ({ role: 'TRAINER' }) },
    clientOrganizationEnrollment: { findMany: async () => [{ clientUserId: 'client-id', client: { id: 'client-id', displayName: 'Client' } }] },
    trainerClientRelationship: { findMany: async () => [trainerRelationship] }
  })['GET /api/v2/organizations/:orgId/clients'];
  await trainerRoute({ sessionUser: legacyAdmin, saasParams: { orgId } }, trainer);
  assert.deepEqual(trainer.body.clients[0].grantedScopes, ['VIEW_BODYWEIGHT']);
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
