import { appendAudit } from './audit.js';
import { createInvitation, invitationHash } from './invitations.js';
import { ensureIdentity } from './identity.js';
import { ACCESS_SCOPES, MEMBERSHIP_ROLES, canManageOrganization, hasPlatformAdmin, organizationRole } from './policy.js';

const ENABLED = process.env.SAAS_ENABLED === '1' || process.env.SAAS_ENABLED === 'true';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVITE_DAYS_MAX = 30;
const GRANT_DAYS_MAX = 365;

class SaasError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const fail = (status, message, code) => { throw new SaasError(status, message, code); };
const notFound = () => fail(404, 'not found');
const invalid = message => fail(400, message);
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const publicOrg = org => ({ id: org.id, type: org.type, name: org.name, slug: org.slug, status: org.status, createdAt: org.createdAt });

function parseDays(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) invalid(`expiresInDays must be between 1 and ${max}`);
  return value;
}

function parseGrantExpiry(value, allowEmpty) {
  if (allowEmpty && value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value)) invalid('expiresAt must be an ISO timestamp');
  const date = new Date(value);
  const days = (date.getTime() - Date.now()) / 86400000;
  if (!Number.isFinite(date.getTime()) || days <= 0 || days > GRANT_DAYS_MAX) {
    invalid(`expiresAt must be within the next ${GRANT_DAYS_MAX} days`);
  }
  return date;
}

function validName(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) invalid(`${field} must contain 1 to 120 characters`);
  return value.trim();
}

function validSlug(value) {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(value)) {
    invalid('slug must be lowercase letters, numbers, and internal hyphens (max 80 characters)');
  }
  return value;
}

function validLegacyUid(value) {
  if (typeof value !== 'string' || !value || value.length > 128) invalid('legacy user id is invalid');
  return value;
}

function assertKeys(body, allowed) {
  if (!isObject(body) || !onlyKeys(body, allowed)) invalid('invalid request body');
}

async function activeLegacyUser(legacyUserById, legacyUid) {
  if (legacyUid == null) return null;
  const id = validLegacyUid(legacyUid);
  const user = legacyUserById(id);
  if (!user || user.disabled) notFound();
  return user;
}

async function createAuditedInvitation(tx, input, actor, legacyUid) {
  const created = await createInvitation(tx, input);
  await appendAudit(tx, {
    actorUserId: actor.id, actorLegacyUid: legacyUid,
    targetUserId: input.targetUserId || null,
    organizationId: input.organizationId,
    action: 'invitation.created', entityType: 'OrganizationInvitation', entityId: created.invitation.id,
    metadata: { type: input.type, role: input.role || null, expiresAt: created.invitation.expiresAt.toISOString() }
  });
  return {
    invitation: {
      id: created.invitation.id, type: created.invitation.type,
      role: created.invitation.role, expiresAt: created.invitation.expiresAt
    },
    token: created.token
  };
}

async function requireOrganization(db, actor, organizationId, roles) {
  if (!ID.test(organizationId)) notFound();
  const role = await organizationRole(db, actor.id, organizationId);
  if (!role || (roles && !roles.includes(role))) notFound();
  return role;
}

async function revokeRelationship(tx, relationship, actor, legacyUid, reason = 'consent withdrawn') {
  const now = new Date();
  const grants = await tx.clientAccessGrant.findMany({ where: { relationshipId: relationship.id, revokedAt: null } });
  for (const grant of grants) {
    await tx.clientAccessGrant.update({
      where: { id: grant.id }, data: { revokedAt: now, revokedByUserId: actor.id }
    });
    await appendAudit(tx, {
      actorUserId: actor.id, actorLegacyUid: legacyUid,
      targetUserId: relationship.clientUserId, organizationId: relationship.organizationId,
      action: 'permission.revoked', entityType: 'ClientAccessGrant', entityId: grant.id,
      metadata: { scope: grant.scope, reason }
    });
  }
  if (relationship.status !== 'REVOKED') {
    await tx.trainerClientRelationship.update({
      where: { id: relationship.id }, data: { status: 'REVOKED', revokedAt: now }
    });
    await appendAudit(tx, {
      actorUserId: actor.id, actorLegacyUid: legacyUid,
      targetUserId: relationship.clientUserId, organizationId: relationship.organizationId,
      action: 'relationship.revoked', entityType: 'TrainerClientRelationship', entityId: relationship.id,
      metadata: { reason }
    });
  }
}

async function revokeOrganizationUserAccess(tx, organizationId, userId, actor, legacyUid, reason) {
  const relationships = await tx.trainerClientRelationship.findMany({
    where: {
      organizationId,
      OR: [{ trainerUserId: userId }, { clientUserId: userId }],
      status: { in: ['PENDING', 'ACTIVE'] }
    }
  });
  for (const relationship of relationships) await revokeRelationship(tx, relationship, actor, legacyUid, reason);

  const enrollment = await tx.clientOrganizationEnrollment.findUnique({
    where: { organizationId_clientUserId: { organizationId, clientUserId: userId } }
  });
  if (enrollment?.status === 'ACTIVE') {
    await tx.clientOrganizationEnrollment.update({
      where: { id: enrollment.id }, data: { status: 'ENDED', endedAt: new Date() }
    });
    await appendAudit(tx, {
      actorUserId: actor.id, actorLegacyUid: legacyUid,
      targetUserId: userId, organizationId,
      action: 'client.enrollment.ended', entityType: 'ClientOrganizationEnrollment', entityId: enrollment.id,
      metadata: { reason }
    });
  }

  const target = await tx.user.findUnique({ where: { id: userId }, select: { legacyUidHash: true } });
  const invitations = await tx.organizationInvitation.findMany({
    where: {
      organizationId, acceptedAt: null, revokedAt: null,
      OR: [
        { createdByUserId: userId }, { trainerUserId: userId },
        { targetLegacyUidHash: target?.legacyUidHash || '' }
      ]
    }
  });
  for (const invitation of invitations) {
    await tx.organizationInvitation.update({ where: { id: invitation.id }, data: { revokedAt: new Date() } });
    await appendAudit(tx, {
      actorUserId: actor.id, actorLegacyUid: legacyUid,
      targetUserId: userId, organizationId,
      action: 'invitation.revoked', entityType: 'OrganizationInvitation', entityId: invitation.id,
      metadata: { reason }
    });
  }
}

async function acceptInvitation(db, invitationId, actor, legacyUser) {
  const now = new Date();
  return db.$transaction(async tx => {
    const invitation = await tx.organizationInvitation.findUnique({ where: { id: invitationId } });
    if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= now) notFound();
    if (invitation.targetLegacyUid && invitation.targetLegacyUid !== String(legacyUser.id)) notFound();
    const organization = await tx.organization.findFirst({ where: { id: invitation.organizationId, status: 'ACTIVE' } });
    if (!organization) notFound();

    if (invitation.createdByPlatformAdmin) {
      if (!await hasPlatformAdmin(tx, invitation.createdByUserId)) notFound();
    } else {
      const inviterRole = await organizationRole(tx, invitation.createdByUserId, invitation.organizationId);
      const allowed = invitation.type === 'MEMBERSHIP' ? ['OWNER', 'ADMIN'] : ['OWNER', 'ADMIN', 'TRAINER'];
      if (!allowed.includes(inviterRole)) notFound();
    }

    const claim = await tx.organizationInvitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { acceptedAt: now, acceptedByUserId: actor.id }
    });
    if (claim.count !== 1) notFound();

    let membership = null, enrollment = null, relationship = null;
    if (invitation.type === 'MEMBERSHIP') {
      if (!invitation.role) notFound();
      const prior = await tx.organizationMembership.findUnique({
        where: { organizationId_userId: { organizationId: invitation.organizationId, userId: actor.id } }
      });
      if (prior?.status === 'ACTIVE') fail(409, 'already a member', 'already_member');
      membership = prior
        ? await tx.organizationMembership.update({
          where: { id: prior.id }, data: { role: invitation.role, status: 'ACTIVE', joinedAt: now }
        })
        : await tx.organizationMembership.create({
          data: { organizationId: invitation.organizationId, userId: actor.id, role: invitation.role, status: 'ACTIVE' }
        });
      await appendAudit(tx, {
        actorUserId: actor.id, actorLegacyUid: legacyUser.id,
        targetUserId: actor.id, organizationId: invitation.organizationId,
        action: prior ? 'membership.reactivated' : 'membership.joined',
        entityType: 'OrganizationMembership', entityId: membership.id,
        metadata: { role: membership.role }
      });
    } else if (invitation.type === 'CLIENT_RELATIONSHIP') {
      if (!invitation.trainerUserId || invitation.trainerUserId === actor.id) notFound();
      const trainer = await tx.user.findUnique({ where: { id: invitation.trainerUserId } });
      const trainerRole = await organizationRole(tx, invitation.trainerUserId, invitation.organizationId);
      if (trainer?.status !== 'ACTIVE' || !['OWNER', 'ADMIN', 'TRAINER'].includes(trainerRole)) notFound();

      enrollment = await tx.clientOrganizationEnrollment.findUnique({
        where: { organizationId_clientUserId: { organizationId: invitation.organizationId, clientUserId: actor.id } }
      });
      if (enrollment?.status === 'ACTIVE') {
        enrollment = null;
      } else if (enrollment) {
        enrollment = await tx.clientOrganizationEnrollment.update({
          where: { id: enrollment.id }, data: { status: 'ACTIVE', enrolledAt: now, endedAt: null }
        });
      } else {
        enrollment = await tx.clientOrganizationEnrollment.create({
          data: { organizationId: invitation.organizationId, clientUserId: actor.id }
        });
      }
      if (enrollment) await appendAudit(tx, {
        actorUserId: actor.id, actorLegacyUid: legacyUser.id,
        targetUserId: actor.id, organizationId: invitation.organizationId,
        action: 'client.enrolled', entityType: 'ClientOrganizationEnrollment', entityId: enrollment.id
      });

      const prior = await tx.trainerClientRelationship.findUnique({
        where: {
          organizationId_trainerUserId_clientUserId: {
            organizationId: invitation.organizationId, trainerUserId: invitation.trainerUserId, clientUserId: actor.id
          }
        }
      });
      relationship = prior
        ? await tx.trainerClientRelationship.update({
          where: { id: prior.id }, data: { status: 'ACTIVE', acceptedAt: now, revokedAt: null }
        })
        : await tx.trainerClientRelationship.create({
          data: {
            organizationId: invitation.organizationId, trainerUserId: invitation.trainerUserId,
            clientUserId: actor.id, status: 'ACTIVE', acceptedAt: now
          }
        });
      if (!prior || prior.status !== 'ACTIVE') await appendAudit(tx, {
        actorUserId: actor.id, actorLegacyUid: legacyUser.id,
        targetUserId: actor.id, organizationId: invitation.organizationId,
        action: prior ? 'relationship.reactivated' : 'relationship.accepted',
        entityType: 'TrainerClientRelationship', entityId: relationship.id
      });
    } else notFound();

    await appendAudit(tx, {
      actorUserId: actor.id, actorLegacyUid: legacyUser.id,
      targetUserId: actor.id, organizationId: invitation.organizationId,
      action: 'invitation.accepted', entityType: 'OrganizationInvitation', entityId: invitation.id,
      metadata: { type: invitation.type }
    });
    return { invitationId: invitation.id, membership, enrollment, relationship };
  });
}

export function saasRoutes({ json, readBody, readSession, getDb, legacyUserById }) {
  const unavailable = res => json(res, 503, { error: 'SaaS is temporarily unavailable' });
  const handle = (key, fn) => async (req, res) => {
    if (!ENABLED) return json(res, 404, { error: 'not found' });
    const legacyUser = readSession(req);
    if (!legacyUser) return json(res, 401, { error: 'not signed in' });
    try {
      const db = await getDb();
      const actor = await ensureIdentity(db, legacyUser);
      if (!actor || actor.status !== 'ACTIVE') return json(res, 403, { error: 'forbidden' });
      await fn(req, res, { db, actor, legacyUser });
    } catch (error) {
      if (error instanceof SaasError) return json(res, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
      if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) return json(res, error.status, { error: error.message });
      if (error?.code === 'P2002') return json(res, 409, { error: 'conflict' });
      if (error?.code === 'P2025') return json(res, 404, { error: 'not found' });
      console.error('SaaS route failed', key, error?.code || error?.name || 'unknown error');
      return unavailable(res);
    }
  };

  return {
    'POST /api/v2/platform/organizations': handle('POST /api/v2/platform/organizations', async (req, res, { db, actor, legacyUser }) => {
      if (!await hasPlatformAdmin(db, actor.id)) notFound();
      const body = await readBody(req);
      assertKeys(body, ['type', 'name', 'slug', 'ownerLegacyUid']);
      if (!['GYM', 'TRAINER_BUSINESS'].includes(body.type)) invalid('type must be GYM or TRAINER_BUSINESS');
      const name = validName(body.name, 'name'), slug = validSlug(body.slug);
      const targetLegacyUser = await activeLegacyUser(legacyUserById, body.ownerLegacyUid);
      const result = await db.$transaction(async tx => {
        const owner = await ensureIdentity(tx, targetLegacyUser);
        if (!owner || owner.status !== 'ACTIVE') notFound();
        const organization = await tx.organization.create({ data: { type: body.type, name, slug } });
        const invitation = await createAuditedInvitation(tx, {
          organizationId: organization.id, type: 'MEMBERSHIP', role: 'OWNER',
          targetLegacyUid: targetLegacyUser.id, targetUserId: owner.id,
          createdByUserId: actor.id, createdByPlatformAdmin: true, expiresInDays: 7
        }, actor, legacyUser.id);
        await appendAudit(tx, {
          actorUserId: actor.id, actorLegacyUid: legacyUser.id,
          targetUserId: owner.id, organizationId: organization.id,
          action: 'organization.created', entityType: 'Organization', entityId: organization.id,
          metadata: { type: organization.type, slug: organization.slug }
        });
        return { organization, ownerInvitation: invitation };
      });
      json(res, 201, { organization: publicOrg(result.organization), ownerInvitation: result.ownerInvitation });
    }),

    'GET /api/v2/platform/organizations': handle('GET /api/v2/platform/organizations', async (_req, res, { db, actor }) => {
      if (!await hasPlatformAdmin(db, actor.id)) notFound();
      const organizations = await db.organization.findMany({ orderBy: { createdAt: 'desc' } });
      json(res, 200, { organizations: organizations.map(publicOrg) });
    }),

    'GET /api/v2/organizations/me': handle('GET /api/v2/organizations/me', async (_req, res, { db, actor }) => {
      const [memberships, enrollments] = await Promise.all([
        db.organizationMembership.findMany({
          where: { userId: actor.id, status: 'ACTIVE', organization: { status: 'ACTIVE' } },
          include: { organization: true }, orderBy: { joinedAt: 'asc' }
        }),
        db.clientOrganizationEnrollment.findMany({
          where: { clientUserId: actor.id, status: 'ACTIVE', organization: { status: 'ACTIVE' } },
          include: { organization: true }, orderBy: { enrolledAt: 'asc' }
        })
      ]);
      const rows = new Map();
      for (const row of memberships) rows.set(row.organizationId, {
        ...publicOrg(row.organization), membershipRole: row.role, enrolledAsClient: false
      });
      for (const row of enrollments) {
        const prior = rows.get(row.organizationId);
        rows.set(row.organizationId, { ...publicOrg(row.organization), membershipRole: prior?.membershipRole || null, enrolledAsClient: true });
      }
      json(res, 200, { organizations: [...rows.values()] });
    }),

    'POST /api/v2/organizations/:orgId/members/invitations': handle('POST /api/v2/organizations/:orgId/members/invitations', async (req, res, { db, actor, legacyUser }) => {
      const { orgId } = req.saasParams;
      const actorRole = await requireOrganization(db, actor, orgId, ['OWNER', 'ADMIN']);
      const body = await readBody(req);
      assertKeys(body, ['role', 'targetLegacyUid', 'expiresInDays']);
      if (!MEMBERSHIP_ROLES.includes(body.role) || (body.role === 'OWNER' && actorRole !== 'OWNER')) invalid('role is not allowed');
      const days = parseDays(body.expiresInDays, 7, INVITE_DAYS_MAX);
      const targetLegacyUser = await activeLegacyUser(legacyUserById, body.targetLegacyUid);
      const result = await db.$transaction(async tx => {
        let targetUserId = null;
        if (targetLegacyUser) {
          const target = await ensureIdentity(tx, targetLegacyUser);
          if (!target || target.status !== 'ACTIVE') notFound();
          targetUserId = target.id;
          const current = await tx.organizationMembership.findUnique({
            where: { organizationId_userId: { organizationId: orgId, userId: target.id } }
          });
          if (current?.status === 'ACTIVE') fail(409, 'already a member', 'already_member');
        }
        return createAuditedInvitation(tx, {
          organizationId: orgId, type: 'MEMBERSHIP', role: body.role,
          targetLegacyUid: targetLegacyUser?.id, targetUserId,
          createdByUserId: actor.id, expiresInDays: days
        }, actor, legacyUser.id);
      });
      json(res, 201, result);
    }),

    'POST /api/v2/organizations/:orgId/clients/invitations': handle('POST /api/v2/organizations/:orgId/clients/invitations', async (req, res, { db, actor, legacyUser }) => {
      const { orgId } = req.saasParams;
      await requireOrganization(db, actor, orgId, ['OWNER', 'ADMIN', 'TRAINER']);
      const body = await readBody(req);
      assertKeys(body, ['clientLegacyUid', 'expiresInDays']);
      const days = parseDays(body.expiresInDays, 7, INVITE_DAYS_MAX);
      const targetLegacyUser = await activeLegacyUser(legacyUserById, body.clientLegacyUid);
      if (targetLegacyUser?.id === legacyUser.id) invalid('a user cannot invite themselves as a client');
      const result = await db.$transaction(async tx => {
        let targetUserId = null;
        if (targetLegacyUser) {
          const target = await ensureIdentity(tx, targetLegacyUser);
          if (!target || target.status !== 'ACTIVE') notFound();
          targetUserId = target.id;
        }
        return createAuditedInvitation(tx, {
          organizationId: orgId, type: 'CLIENT_RELATIONSHIP', trainerUserId: actor.id,
          targetLegacyUid: targetLegacyUser?.id, targetUserId,
          createdByUserId: actor.id, expiresInDays: days
        }, actor, legacyUser.id);
      });
      json(res, 201, result);
    }),

    'POST /api/v2/invitations/accept': handle('POST /api/v2/invitations/accept', async (req, res, { db, actor, legacyUser }) => {
      const body = await readBody(req);
      assertKeys(body, ['token']);
      if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{40,50}$/.test(body.token)) notFound();
      const invitation = await db.organizationInvitation.findUnique({ where: { tokenHash: invitationHash(body.token) } });
      if (!invitation) notFound();
      const result = await acceptInvitation(db, invitation.id, actor, legacyUser);
      json(res, 200, result);
    }),

    'DELETE /api/v2/organizations/:orgId/invitations/:invitationId': handle('DELETE /api/v2/organizations/:orgId/invitations/:invitationId', async (req, res, { db, actor, legacyUser }) => {
      const { orgId, invitationId } = req.saasParams;
      if (!ID.test(invitationId)) notFound();
      const invitation = await db.organizationInvitation.findFirst({ where: { id: invitationId, organizationId: orgId } });
      if (!invitation) notFound();
      const role = await requireOrganization(db, actor, orgId);
      if (!['OWNER', 'ADMIN'].includes(role) && invitation.createdByUserId !== actor.id) notFound();
      const now = new Date();
      await db.$transaction(async tx => {
        const changed = await tx.organizationInvitation.updateMany({
          where: { id: invitationId, organizationId: orgId, acceptedAt: null, revokedAt: null }, data: { revokedAt: now }
        });
        if (!changed.count) fail(409, 'invitation is no longer active', 'invitation_inactive');
        await appendAudit(tx, {
          actorUserId: actor.id, actorLegacyUid: legacyUser.id,
          organizationId: orgId, action: 'invitation.revoked',
          entityType: 'OrganizationInvitation', entityId: invitationId
        });
      });
      json(res, 200, { ok: true });
    }),

    'GET /api/v2/organizations/:orgId/trainers': handle('GET /api/v2/organizations/:orgId/trainers', async (req, res, { db, actor }) => {
      const { orgId } = req.saasParams;
      const memberRole = await organizationRole(db, actor.id, orgId);
      const enrollment = await db.clientOrganizationEnrollment.findFirst({ where: { organizationId: orgId, clientUserId: actor.id, status: 'ACTIVE', organization: { status: 'ACTIVE' } } });
      if (!memberRole && !enrollment) notFound();
      let userIds;
      if (memberRole) {
        const memberships = await db.organizationMembership.findMany({
          where: { organizationId: orgId, status: 'ACTIVE', role: { in: ['OWNER', 'TRAINER'] } },
          select: { userId: true, role: true, user: { select: { displayName: true } } }
        });
        return json(res, 200, { trainers: memberships.map(row => ({ userId: row.userId, displayName: row.user.displayName, role: row.role })) });
      }
      userIds = await db.trainerClientRelationship.findMany({
        where: { organizationId: orgId, clientUserId: actor.id, status: 'ACTIVE', trainer: { status: 'ACTIVE' } },
        include: { trainer: { select: { id: true, displayName: true } } }
      });
      json(res, 200, { trainers: userIds.map(row => ({ userId: row.trainer.id, displayName: row.trainer.displayName, role: 'TRAINER' })) });
    }),

    'GET /api/v2/organizations/:orgId/clients': handle('GET /api/v2/organizations/:orgId/clients', async (req, res, { db, actor }) => {
      const { orgId } = req.saasParams;
      const role = await organizationRole(db, actor.id, orgId);
      if (!role || role === 'STAFF') notFound();
      const where = {
        organizationId: orgId, status: 'ACTIVE', client: { status: 'ACTIVE' },
        ...(role === 'TRAINER' ? { client: { status: 'ACTIVE', clientRelationships: { some: { organizationId: orgId, trainerUserId: actor.id, status: 'ACTIVE' } } } } : {})
      };
      const enrollments = await db.clientOrganizationEnrollment.findMany({
        where, include: { client: { select: { id: true, displayName: true } } }, orderBy: { enrolledAt: 'desc' }
      });
      const relationships = await db.trainerClientRelationship.findMany({
        where: { organizationId: orgId, trainerUserId: actor.id, status: 'ACTIVE', clientUserId: { in: enrollments.map(row => row.clientUserId) } },
        include: { grants: { where: { revokedAt: null, expiresAt: { gt: new Date() } }, select: { scope: true, expiresAt: true } } }
      });
      const byClient = new Map(relationships.map(row => [row.clientUserId, row]));
      json(res, 200, { clients: enrollments.map(row => {
        const relationship = byClient.get(row.clientUserId);
        return {
          userId: row.client.id, displayName: row.client.displayName,
          ...(relationship ? {
            relationshipId: relationship.id,
            ...(role === 'TRAINER' ? {
              grantedScopes: relationship.grants.map(grant => grant.scope),
              grantsExpireAt: relationship.grants.reduce((soonest, grant) => !soonest || grant.expiresAt < soonest ? grant.expiresAt : soonest, null)
            } : {})
          } : {})
        };
      }) });
    }),

    'PUT /api/v2/organizations/:orgId/members/:userId': handle('PUT /api/v2/organizations/:orgId/members/:userId', async (req, res, { db, actor, legacyUser }) => {
      const { orgId, userId } = req.saasParams;
      if (!ID.test(userId) || actor.id === userId) notFound();
      const actorRole = await requireOrganization(db, actor, orgId, ['OWNER', 'ADMIN']);
      const body = await readBody(req);
      assertKeys(body, ['role', 'status']);
      if (!Object.keys(body).length) invalid('membership update is empty');
      if (body.role !== undefined && (!MEMBERSHIP_ROLES.includes(body.role) || body.role === 'OWNER' || (body.role === 'ADMIN' && actorRole !== 'OWNER'))) invalid('role is not allowed');
      if (body.status !== undefined && !['ACTIVE', 'SUSPENDED'].includes(body.status)) invalid('status must be ACTIVE or SUSPENDED');
      const result = await db.$transaction(async tx => {
        const membership = await tx.organizationMembership.findUnique({
          where: { organizationId_userId: { organizationId: orgId, userId } }, include: { user: true }
        });
        if (!membership || membership.role === 'OWNER' || (actorRole === 'ADMIN' && membership.role === 'ADMIN') || membership.user.status !== 'ACTIVE') notFound();
        const data = { ...(body.role ? { role: body.role } : {}), ...(body.status ? { status: body.status } : {}) };
        const updated = await tx.organizationMembership.update({ where: { id: membership.id }, data });
        if (updated.status === 'SUSPENDED' || (membership.role !== 'STAFF' && updated.role === 'STAFF')) {
          await revokeOrganizationUserAccess(tx, orgId, userId, actor, legacyUser.id, 'membership changed');
        }
        await appendAudit(tx, {
          actorUserId: actor.id, actorLegacyUid: legacyUser.id,
          targetUserId: userId, organizationId: orgId,
          action: 'membership.updated', entityType: 'OrganizationMembership', entityId: membership.id,
          metadata: { previousRole: membership.role, role: updated.role, previousStatus: membership.status, status: updated.status }
        });
        return updated;
      });
      json(res, 200, { membership: { id: result.id, userId: result.userId, role: result.role, status: result.status } });
    }),

    'DELETE /api/v2/organizations/:orgId/members/:userId': handle('DELETE /api/v2/organizations/:orgId/members/:userId', async (req, res, { db, actor, legacyUser }) => {
      const { orgId, userId } = req.saasParams;
      if (!ID.test(userId)) notFound();
      const role = await requireOrganization(db, actor, orgId);
      const self = actor.id === userId;
      if (!self && !['OWNER', 'ADMIN'].includes(role)) notFound();
      const result = await db.$transaction(async tx => {
        const membership = await tx.organizationMembership.findUnique({ where: { organizationId_userId: { organizationId: orgId, userId } } });
        if (!membership || membership.role === 'OWNER' || (!self && role === 'ADMIN' && membership.role === 'ADMIN')) notFound();
        if (membership.status !== 'ACTIVE') return membership;
        const updated = await tx.organizationMembership.update({ where: { id: membership.id }, data: { status: 'SUSPENDED' } });
        await revokeOrganizationUserAccess(tx, orgId, userId, actor, legacyUser.id, 'membership ended');
        await appendAudit(tx, {
          actorUserId: actor.id, actorLegacyUid: legacyUser.id,
          targetUserId: userId, organizationId: orgId,
          action: 'membership.suspended', entityType: 'OrganizationMembership', entityId: membership.id,
          metadata: { reason: self ? 'member left' : 'admin removed member' }
        });
        return updated;
      });
      json(res, 200, { membership: { id: result.id, userId: result.userId, role: result.role, status: result.status } });
    }),

    'DELETE /api/v2/organizations/:orgId/clients/me': handle('DELETE /api/v2/organizations/:orgId/clients/me', async (req, res, { db, actor, legacyUser }) => {
      const { orgId } = req.saasParams;
      const result = await db.$transaction(async tx => {
        const enrollment = await tx.clientOrganizationEnrollment.findUnique({
          where: { organizationId_clientUserId: { organizationId: orgId, clientUserId: actor.id } }
        });
        if (!enrollment) notFound();
        if (enrollment.status === 'ACTIVE') {
          await tx.clientOrganizationEnrollment.update({ where: { id: enrollment.id }, data: { status: 'ENDED', endedAt: new Date() } });
          const relationships = await tx.trainerClientRelationship.findMany({
            where: { organizationId: orgId, clientUserId: actor.id, status: { in: ['PENDING', 'ACTIVE'] } }
          });
          for (const relationship of relationships) await revokeRelationship(tx, relationship, actor, legacyUser.id, 'client left organization');
          await appendAudit(tx, {
            actorUserId: actor.id, actorLegacyUid: legacyUser.id,
            targetUserId: actor.id, organizationId: orgId,
            action: 'client.enrollment.ended', entityType: 'ClientOrganizationEnrollment', entityId: enrollment.id
          });
        }
        return enrollment;
      });
      json(res, 200, { enrollment: { id: result.id, status: 'ENDED' } });
    }),

    'POST /api/v2/coaching/relationships/:id/revoke': handle('POST /api/v2/coaching/relationships/:id/revoke', async (req, res, { db, actor, legacyUser }) => {
      const { id } = req.saasParams;
      if (!ID.test(id)) notFound();
      const relationship = await db.trainerClientRelationship.findUnique({ where: { id } });
      if (!relationship) notFound();
      const memberRole = await organizationRole(db, actor.id, relationship.organizationId);
      const canManage = ['OWNER', 'ADMIN'].includes(memberRole);
      if (actor.id !== relationship.clientUserId && actor.id !== relationship.trainerUserId && !canManage) notFound();
      await db.$transaction(tx => revokeRelationship(tx, relationship, actor, legacyUser.id));
      json(res, 200, { relationship: { id, status: 'REVOKED' } });
    }),

    'PUT /api/v2/coaching/relationships/:id/grants': handle('PUT /api/v2/coaching/relationships/:id/grants', async (req, res, { db, actor, legacyUser }) => {
      const { id } = req.saasParams;
      if (!ID.test(id)) notFound();
      const body = await readBody(req);
      assertKeys(body, ['scopes', 'expiresAt']);
      if (!Array.isArray(body.scopes) || body.scopes.length > ACCESS_SCOPES.length || body.scopes.some(scope => !ACCESS_SCOPES.includes(scope)) || new Set(body.scopes).size !== body.scopes.length) {
        invalid('scopes must be a unique list of supported permissions');
      }
      const expiresAt = body.scopes.length ? parseGrantExpiry(body.expiresAt, false) : null;
      const relationship = await db.trainerClientRelationship.findUnique({ where: { id } });
      if (!relationship || relationship.clientUserId !== actor.id || relationship.status !== 'ACTIVE') notFound();
      const trainerRole = await organizationRole(db, relationship.trainerUserId, relationship.organizationId);
      const enrollment = await db.clientOrganizationEnrollment.findUnique({
        where: { organizationId_clientUserId: { organizationId: relationship.organizationId, clientUserId: actor.id } }
      });
      if (!['OWNER', 'ADMIN', 'TRAINER'].includes(trainerRole) || enrollment?.status !== 'ACTIVE') notFound();

      const grants = await db.$transaction(async tx => {
        const now = new Date();
        const current = await tx.clientAccessGrant.findMany({ where: { relationshipId: id, revokedAt: null } });
        const activeByScope = new Map(current.filter(grant => grant.expiresAt > now).map(grant => [grant.scope, grant]));
        const desired = new Set(body.scopes);
        for (const grant of current) {
          if (grant.revokedAt === null && grant.expiresAt > now && (!desired.has(grant.scope) || grant.expiresAt.getTime() !== expiresAt?.getTime())) {
            await tx.clientAccessGrant.update({ where: { id: grant.id }, data: { revokedAt: now, revokedByUserId: actor.id } });
            await appendAudit(tx, {
              actorUserId: actor.id, actorLegacyUid: legacyUser.id,
              targetUserId: actor.id, organizationId: relationship.organizationId,
              action: 'permission.revoked', entityType: 'ClientAccessGrant', entityId: grant.id,
              metadata: { scope: grant.scope, reason: 'consent changed' }
            });
          }
        }
        for (const scope of desired) {
          const grant = activeByScope.get(scope);
          if (grant && grant.expiresAt.getTime() === expiresAt.getTime()) continue;
          const created = await tx.clientAccessGrant.create({
            data: { relationshipId: id, scope, grantedByUserId: actor.id, expiresAt }
          });
          await appendAudit(tx, {
            actorUserId: actor.id, actorLegacyUid: legacyUser.id,
            targetUserId: actor.id, organizationId: relationship.organizationId,
            action: 'permission.granted', entityType: 'ClientAccessGrant', entityId: created.id,
            metadata: { scope, expiresAt: expiresAt.toISOString() }
          });
        }
        return tx.clientAccessGrant.findMany({
          where: { relationshipId: id, revokedAt: null, expiresAt: { gt: now } }, orderBy: { scope: 'asc' }
        });
      });
      json(res, 200, { grants: grants.map(grant => ({ id: grant.id, scope: grant.scope, expiresAt: grant.expiresAt })) });
    })
  };
}

export function matchSaasRoute(routes, method, pathname) {
  const exact = `${method} ${pathname}`;
  if (routes[exact]) return { key: exact, params: {} };
  for (const key of Object.keys(routes)) {
    const split = key.indexOf(' ');
    if (key.slice(0, split) !== method || !key.slice(split + 1).includes('/:')) continue;
    const names = [];
    const pattern = key.slice(split + 1).split('/').map(part => {
      if (!part.startsWith(':')) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(part.slice(1));
      return '([^/]+)';
    }).join('/');
    const match = new RegExp(`^${pattern}$`).exec(pathname);
    if (!match) continue;
    const params = {};
    try { names.forEach((name, index) => { params[name] = decodeURIComponent(match[index + 1]); }); }
    catch { return null; }
    return { key, params };
  }
  return null;
}
