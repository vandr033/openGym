import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureIdentity, legacyUidHash } from '../saas/identity.js';
import { createInvitation, invitationHash } from '../saas/invitations.js';
import { canAccessClientScope, isGrantEffective } from '../saas/policy.js';
import { matchSaasRoute } from '../saas/routes.js';

test('legacy identities map idempotently without case-folding OpenGym ids', async () => {
  const users = new Map();
  let nextId = 0;
  const tx = {
    user: {
      findUnique: async ({ where }) => users.get(where.legacyUidHash) || null,
      upsert: async ({ where, create, update }) => {
        const row = users.get(where.legacyUidHash) || { ...create, id: `sql-${++nextId}`, status: 'ACTIVE' };
        Object.assign(row, update);
        users.set(where.legacyUidHash, row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = [...users.values()].find(user => user.id === where.id);
        Object.assign(row, data);
        return row;
      }
    }
  };
  const first = await ensureIdentity(tx, { id: 'aBcdEf012345', name: 'Alex' });
  const again = await ensureIdentity(tx, { id: 'aBcdEf012345', name: 'Alex Updated' });
  const caseVariant = await ensureIdentity(tx, { id: 'AbcdEf012345', name: 'Alex' });

  assert.equal(again.id, first.id);
  assert.equal(again.legacyUid, 'aBcdEf012345');
  assert.equal(again.displayName, 'Alex Updated');
  assert.notEqual(caseVariant.id, first.id);
  assert.equal(users.size, 2);
  assert.equal(legacyUidHash('aBcdEf012345').length, 64);
});

test('invitations return a one-use secret while only its digest is persisted', async () => {
  let saved;
  const created = await createInvitation({
    organizationInvitation: { create: async ({ data }) => (saved = { id: 'invite-id', ...data }) }
  }, {
    organizationId: 'org-id', type: 'MEMBERSHIP', role: 'TRAINER',
    targetLegacyUid: 'LegacyCaseSensitiveId', createdByUserId: 'actor-id', expiresInDays: 7
  });

  assert.match(created.token, /^[A-Za-z0-9_-]{40,50}$/);
  assert.equal(saved.tokenHash, invitationHash(created.token));
  assert.notEqual(saved.tokenHash, created.token);
  assert.equal(saved.targetLegacyUid, 'LegacyCaseSensitiveId');
  assert.ok(saved.expiresAt > new Date());
  assert.ok(!Object.values(saved).includes(created.token));
});

test('private client scope requires an active organization, relationship, enrollment, and matching grant', async () => {
  let query;
  const db = { organization: { findFirst: async ({ where }) => { query = where; return { id: where.id }; } } };
  assert.equal(await canAccessClientScope(db, {
    actorUserId: 'trainer', clientUserId: 'client', organizationId: 'org', scope: 'VIEW_TRAINING'
  }), true);
  assert.equal(query.status, 'ACTIVE');
  assert.equal(query.memberships.some.userId, 'trainer');
  assert.equal(query.memberships.some.status, 'ACTIVE');
  assert.equal(query.enrollments.some.clientUserId, 'client');
  assert.equal(query.relationships.some.trainerUserId, 'trainer');
  assert.deepEqual(query.relationships.some.grants.some, {
    scope: 'VIEW_TRAINING', revokedAt: null, expiresAt: query.relationships.some.grants.some.expiresAt
  });

  db.organization.findFirst = async () => null;
  assert.equal(await canAccessClientScope(db, {
    actorUserId: 'trainer', clientUserId: 'client', organizationId: 'other-org', scope: 'VIEW_TRAINING'
  }), false);
});

test('grant effectiveness checks scope, revocation, and expiry', () => {
  const now = new Date('2026-10-13T12:00:00Z');
  assert.equal(isGrantEffective({ scope: 'VIEW_TRAINING', expiresAt: new Date('2026-10-14T12:00:00Z') }, 'VIEW_TRAINING', now), true);
  assert.equal(isGrantEffective({ scope: 'VIEW_TRAINING', expiresAt: new Date('2026-10-13T12:00:00Z') }, 'VIEW_TRAINING', now), false);
  assert.equal(isGrantEffective({ scope: 'VIEW_TRAINING', expiresAt: new Date('2026-10-14T12:00:00Z'), revokedAt: now }, 'VIEW_TRAINING', now), false);
  assert.equal(isGrantEffective({ scope: 'VIEW_TRAINING', expiresAt: new Date('2026-10-14T12:00:00Z') }, 'LOG_SETS', now), false);
});

test('parameterized SaaS routes match a single path segment', () => {
  const routes = { 'GET /api/v2/organizations/:orgId/clients': true };
  assert.deepEqual(matchSaasRoute(routes, 'GET', '/api/v2/organizations/abc/clients'), {
    key: 'GET /api/v2/organizations/:orgId/clients', params: { orgId: 'abc' }
  });
  assert.equal(matchSaasRoute(routes, 'GET', '/api/v2/organizations/a/clients/extra'), null);
});
