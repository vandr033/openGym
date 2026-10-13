import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const connection = process.env.SAAS_TEST_DATABASE_URL;
if (!connection) throw new Error('Set SAAS_TEST_DATABASE_URL to a disposable MySQL database named opengym_saas_test.');
const url = new URL(connection);
if (url.protocol !== 'mysql:' || decodeURIComponent(url.pathname.slice(1)) !== 'opengym_saas_test') {
  throw new Error('Refusing to migrate: SAAS_TEST_DATABASE_URL must be mysql://.../opengym_saas_test.');
}

process.env.DATABASE_URL = connection;
process.env.SAAS_ENABLED = '1';
const prismaCli = path.join(API, 'node_modules', 'prisma', 'build', 'index.js');
const migration = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
  cwd: API, env: process.env, encoding: 'utf8'
});
if (migration.stdout) process.stdout.write(migration.stdout);
if (migration.stderr) process.stderr.write(migration.stderr);
if (migration.status !== 0) throw new Error(`Prisma migration deploy failed (${migration.status ?? migration.signal}).`);

const { getSaasDb, closeSaasDb } = await import('../saas/db.js');
const { provisionPlatformAdmin, deactivateMappedIdentity, ensureIdentity, legacyUidHash } = await import('../saas/identity.js');
const { canAccessClientScope } = await import('../saas/policy.js');
const { matchSaasRoute, saasRoutes } = await import('../saas/routes.js');
const db = await getSaasDb();
const suffix = randomBytes(6).toString('hex');
const users = new Map();
const makeUser = name => {
  const user = { id: randomBytes(12).toString('base64url'), name };
  users.set(user.id, user);
  return user;
};
const platform = makeUser('SaaS test platform admin');
const owner = makeUser('SaaS test owner');
const trainer = makeUser('SaaS test trainer');
const client = makeUser('SaaS test client');
const clientToDelete = makeUser('SaaS test client to delete');
const otherOwner = makeUser('SaaS test other tenant owner');

function apiResponse() { return { statusCode: 0, body: null }; }
const routes = saasRoutes({
  json: (res, statusCode, body) => { res.statusCode = statusCode; res.body = body; },
  readBody: req => req.body,
  readSession: req => req.sessionUser || null,
  getDb: async () => db,
  legacyUserById: id => users.get(id) || null
});
async function request(method, pathname, sessionUser, body) {
  const match = matchSaasRoute(routes, method, pathname);
  assert.ok(match, `missing SaaS route: ${method} ${pathname}`);
  const res = apiResponse();
  await routes[match.key]({ sessionUser, body, saasParams: match.params }, res);
  return res;
}
async function accept(user, token) {
  return request('POST', '/api/v2/invitations/accept', user, { token });
}
async function enrollClient(clientUser, organizationId, token) {
  const response = await accept(clientUser, token);
  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  assert.ok(response.body.enrollment);
  return response.body.relationship;
}

try {
  // A legacy admin bit is deliberately not consulted by this independent provisioning path.
  await provisionPlatformAdmin(db, platform, 'mysql integration test');
  const organizationResponse = await request('POST', '/api/v2/platform/organizations', platform, {
    type: 'GYM', name: 'SaaS Integration Gym', slug: `saas-it-${suffix}`, ownerLegacyUid: owner.id
  });
  assert.equal(organizationResponse.statusCode, 201, JSON.stringify(organizationResponse.body));
  const organization = organizationResponse.body.organization;
  const ownerInvitation = organizationResponse.body.ownerInvitation;
  const storedInvitation = await db.organizationInvitation.findUnique({ where: { tokenHash: createHash('sha256').update(ownerInvitation.token).digest('hex') } });
  assert.ok(storedInvitation);
  assert.notEqual(storedInvitation.tokenHash, ownerInvitation.token);
  assert.equal((await accept(owner, ownerInvitation.token)).statusCode, 200);
  assert.equal((await accept(owner, ownerInvitation.token)).statusCode, 404, 'an invitation must be single-use');

  const trainerInvite = await request('POST', `/api/v2/organizations/${organization.id}/members/invitations`, owner, { role: 'TRAINER' });
  assert.equal(trainerInvite.statusCode, 201, JSON.stringify(trainerInvite.body));
  assert.equal((await accept(trainer, trainerInvite.body.token)).statusCode, 200);
  const clientInvite = await request('POST', `/api/v2/organizations/${organization.id}/clients/invitations`, trainer, { clientLegacyUid: client.id });
  assert.equal(clientInvite.statusCode, 201, JSON.stringify(clientInvite.body));
  const relationship = await enrollClient(client, organization.id, clientInvite.body.token);
  const client2Invite = await request('POST', `/api/v2/organizations/${organization.id}/clients/invitations`, trainer, { clientLegacyUid: clientToDelete.id });
  assert.equal(client2Invite.statusCode, 201, JSON.stringify(client2Invite.body));
  await enrollClient(clientToDelete, organization.id, client2Invite.body.token);

  const trainerSql = await db.user.findUnique({ where: { legacyUidHash: legacyUidHash(trainer.id) } });
  const clientSql = await db.user.findUnique({ where: { legacyUidHash: legacyUidHash(client.id) } });
  assert.equal(await canAccessClientScope(db, {
    actorUserId: trainerSql.id, clientUserId: clientSql.id, organizationId: organization.id, scope: 'VIEW_TRAINING'
  }), false, 'membership, enrollment, and relationship alone grant no private-data access');
  const unauthorizedGrant = await request('PUT', `/api/v2/coaching/relationships/${relationship.id}/grants`, trainer, {
    scopes: ['VIEW_TRAINING'], expiresAt: new Date(Date.now() + 86400000).toISOString()
  });
  assert.equal(unauthorizedGrant.statusCode, 404, 'a trainer cannot grant access on a client’s behalf');

  const consent = await request('PUT', `/api/v2/coaching/relationships/${relationship.id}/grants`, client, {
    scopes: ['VIEW_TRAINING'], expiresAt: new Date(Date.now() + 86400000).toISOString()
  });
  assert.equal(consent.statusCode, 200, JSON.stringify(consent.body));
  assert.equal(await canAccessClientScope(db, {
    actorUserId: trainerSql.id, clientUserId: clientSql.id, organizationId: organization.id, scope: 'VIEW_TRAINING'
  }), true);
  assert.equal(await canAccessClientScope(db, {
    actorUserId: trainerSql.id, clientUserId: clientSql.id, organizationId: organization.id, scope: 'LOG_SETS'
  }), false, 'a grant applies only to the named scope');
  const revoked = await request('POST', `/api/v2/coaching/relationships/${relationship.id}/revoke`, client);
  assert.equal(revoked.statusCode, 200);
  assert.equal(await canAccessClientScope(db, {
    actorUserId: trainerSql.id, clientUserId: clientSql.id, organizationId: organization.id, scope: 'VIEW_TRAINING'
  }), false);

  const otherOrganization = await request('POST', '/api/v2/platform/organizations', platform, {
    type: 'TRAINER_BUSINESS', name: 'SaaS Integration Other Business', slug: `saas-it-other-${suffix}`, ownerLegacyUid: otherOwner.id
  });
  assert.equal(otherOrganization.statusCode, 201, JSON.stringify(otherOrganization.body));
  assert.equal((await accept(otherOwner, otherOrganization.body.ownerInvitation.token)).statusCode, 200);
  const privateList = await request('GET', `/api/v2/organizations/${otherOrganization.body.organization.id}/clients`, trainer);
  assert.equal(privateList.statusCode, 404, 'cross-tenant membership checks use the same 404 as an unknown tenant');
  assert.deepEqual(privateList.body, { error: 'not found' });

  const secondRelationship = await db.trainerClientRelationship.findUnique({ where: {
    organizationId_trainerUserId_clientUserId: {
      organizationId: organization.id, trainerUserId: trainerSql.id,
      clientUserId: (await db.user.findUnique({ where: { legacyUidHash: legacyUidHash(clientToDelete.id) } })).id
    }
  } });
  const client2Sql = await db.user.findUnique({ where: { legacyUidHash: legacyUidHash(clientToDelete.id) } });
  const secondGrant = await request('PUT', `/api/v2/coaching/relationships/${secondRelationship.id}/grants`, clientToDelete, {
    scopes: ['VIEW_TRAINING'], expiresAt: new Date(Date.now() + 86400000).toISOString()
  });
  assert.equal(secondGrant.statusCode, 200, JSON.stringify(secondGrant.body));
  await deactivateMappedIdentity(db, trainer.id, platform, 'DEACTIVATED');
  assert.equal(await db.user.findUnique({ where: { id: trainerSql.id } }).then(row => row.status), 'DEACTIVATED');
  assert.equal(await canAccessClientScope(db, {
    actorUserId: trainerSql.id, clientUserId: client2Sql.id, organizationId: organization.id, scope: 'VIEW_TRAINING'
  }), false, 'deactivation revokes relationships and grants');
  trainer.disabled = true;
  assert.equal(await ensureIdentity(db, trainer), null);
  trainer.disabled = false;
  assert.equal((await ensureIdentity(db, trainer)).status, 'ACTIVE');
  assert.equal(await canAccessClientScope(db, {
    actorUserId: trainerSql.id, clientUserId: client2Sql.id, organizationId: organization.id, scope: 'VIEW_TRAINING'
  }), false, 'reactivation does not restore membership or client consent');

  await deactivateMappedIdentity(db, clientToDelete.id, platform, 'DELETED');
  assert.equal((await ensureIdentity(db, clientToDelete)).status, 'DELETED', 'deleted identities remain tombstoned');
  assert.ok(await db.auditEvent.count({ where: { action: 'permission.granted', organizationId: organization.id } }));
  assert.ok(await db.auditEvent.count({ where: { action: 'relationship.revoked', organizationId: organization.id } }));

  const audit = await db.auditEvent.findFirst({ where: { organizationId: organization.id } });
  await assert.rejects(db.auditEvent.update({ where: { id: audit.id }, data: { action: 'tampered' } }), /append-only|45000|AuditEvent/i);
  await assert.rejects(db.auditEvent.delete({ where: { id: audit.id } }), /append-only|45000|AuditEvent/i);
  console.log('MySQL integration passed: migrations, identity mapping, invitations, tenant authorization, consent, lifecycle revocation, and append-only audit.');
} finally {
  await closeSaasDb();
}
