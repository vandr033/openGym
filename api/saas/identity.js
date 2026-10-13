import { createHash } from 'node:crypto';
import { appendAudit } from './audit.js';

export const legacyUidHash = legacyUid => createHash('sha256').update(String(legacyUid)).digest('hex');

export async function ensureIdentity(tx, legacyUser) {
  if (!legacyUser?.id || legacyUser.disabled) return null;
  const legacyUid = String(legacyUser.id);
  const legacyUidHashValue = legacyUidHash(legacyUid);
  const displayName = String(legacyUser.name || '').trim().slice(0, 120) || null;
  const existing = await tx.user.findUnique({ where: { legacyUidHash: legacyUidHashValue } });
  if (!existing) return tx.user.upsert({
    where: { legacyUidHash: legacyUidHashValue },
    create: { legacyUid, legacyUidHash: legacyUidHashValue, displayName }, update: { displayName }
  });
  if (existing.status === 'DELETED') return existing;
  if (existing.status === 'DEACTIVATED') {
    const changed = await tx.user.updateMany({
      where: { id: existing.id, status: 'DEACTIVATED' }, data: { status: 'ACTIVE', displayName }
    });
    if (changed.count) await appendAudit(tx, {
      actorUserId: existing.id, actorLegacyUid: legacyUid, targetUserId: existing.id,
      action: 'identity.reactivated', entityType: 'User', entityId: existing.id,
      metadata: { membershipsRequireReinvitation: true }
    });
    return tx.user.findUnique({ where: { id: existing.id } });
  }
  return existing.displayName === displayName
    ? existing
    : tx.user.update({ where: { id: existing.id }, data: { displayName } });
}

export async function deactivateMappedIdentity(db, legacyUid, actor, status) {
  const current = await db.user.findUnique({ where: { legacyUidHash: legacyUidHash(legacyUid) } });
  if (!current || current.status === status || current.status === 'DELETED') return false;
  const sqlActor = await ensureIdentity(db, actor);
  if (!sqlActor || sqlActor.status !== 'ACTIVE') throw new Error('admin identity unavailable');
  const now = new Date();
  const actorLegacyUid = String(actor.id);

  await db.$transaction(async tx => {
    await tx.user.update({ where: { id: current.id }, data: { status } });

    const platformAdmin = await tx.platformAdmin.findUnique({ where: { userId: current.id } });
    if (platformAdmin) {
      await tx.platformAdmin.delete({ where: { userId: current.id } });
      await appendAudit(tx, {
        actorUserId: sqlActor.id, actorLegacyUid,
        targetUserId: current.id, action: 'platform_admin.revoked',
        entityType: 'PlatformAdmin', entityId: current.id, metadata: { reason: status.toLowerCase() }
      });
    }

    const memberships = await tx.organizationMembership.findMany({
      where: { userId: current.id, status: 'ACTIVE' }
    });
    for (const membership of memberships) {
      await tx.organizationMembership.update({ where: { id: membership.id }, data: { status: 'SUSPENDED' } });
      await appendAudit(tx, {
        actorUserId: sqlActor.id, actorLegacyUid,
        targetUserId: current.id, organizationId: membership.organizationId,
        action: 'membership.suspended', entityType: 'OrganizationMembership', entityId: membership.id,
        metadata: { reason: status.toLowerCase() }
      });
    }

    const relationships = await tx.trainerClientRelationship.findMany({
      where: { OR: [{ trainerUserId: current.id }, { clientUserId: current.id }], status: { in: ['PENDING', 'ACTIVE'] } }
    });
    for (const relationship of relationships) {
      const grants = await tx.clientAccessGrant.findMany({ where: { relationshipId: relationship.id, revokedAt: null } });
      for (const grant of grants) {
        await tx.clientAccessGrant.update({
          where: { id: grant.id }, data: { revokedAt: now, revokedByUserId: sqlActor.id }
        });
        await appendAudit(tx, {
          actorUserId: sqlActor.id, actorLegacyUid,
          targetUserId: relationship.clientUserId, organizationId: relationship.organizationId,
          action: 'permission.revoked', entityType: 'ClientAccessGrant', entityId: grant.id,
          metadata: { scope: grant.scope, reason: status.toLowerCase() }
        });
      }
      await tx.trainerClientRelationship.update({
        where: { id: relationship.id }, data: { status: 'REVOKED', revokedAt: now }
      });
      await appendAudit(tx, {
        actorUserId: sqlActor.id, actorLegacyUid,
        targetUserId: relationship.clientUserId, organizationId: relationship.organizationId,
        action: 'relationship.revoked', entityType: 'TrainerClientRelationship', entityId: relationship.id,
        metadata: { reason: status.toLowerCase() }
      });
    }

    const enrollments = await tx.clientOrganizationEnrollment.findMany({
      where: { clientUserId: current.id, status: 'ACTIVE' }
    });
    for (const enrollment of enrollments) {
      await tx.clientOrganizationEnrollment.update({
        where: { id: enrollment.id }, data: { status: 'ENDED', endedAt: now }
      });
      await appendAudit(tx, {
        actorUserId: sqlActor.id, actorLegacyUid,
        targetUserId: current.id, organizationId: enrollment.organizationId,
        action: 'client.enrollment.ended', entityType: 'ClientOrganizationEnrollment', entityId: enrollment.id,
        metadata: { reason: status.toLowerCase() }
      });
    }

    const invitations = await tx.organizationInvitation.findMany({
      where: {
        acceptedAt: null, revokedAt: null,
        OR: [
          { createdByUserId: current.id }, { trainerUserId: current.id },
          { targetLegacyUidHash: legacyUidHash(legacyUid) }
        ]
      }
    });
    for (const invitation of invitations) {
      await tx.organizationInvitation.update({ where: { id: invitation.id }, data: { revokedAt: now } });
      await appendAudit(tx, {
        actorUserId: sqlActor.id, actorLegacyUid,
        targetUserId: current.id, organizationId: invitation.organizationId,
        action: 'invitation.revoked', entityType: 'OrganizationInvitation', entityId: invitation.id,
        metadata: { reason: status.toLowerCase() }
      });
    }

    await appendAudit(tx, {
      actorUserId: sqlActor.id, actorLegacyUid,
      targetUserId: current.id, action: `identity.${status.toLowerCase()}`,
      entityType: 'User', entityId: current.id
    });
  });
  return true;
}

export async function provisionPlatformAdmin(db, legacyUser, provisionedBy) {
  return db.$transaction(async tx => {
    const user = await ensureIdentity(tx, legacyUser);
    if (!user || user.status !== 'ACTIVE') throw new Error('legacy account is unavailable');
    const existing = await tx.platformAdmin.findUnique({ where: { userId: user.id } });
    if (existing) return { userId: user.id, created: false };
    await tx.platformAdmin.create({ data: { userId: user.id, grantedBy: provisionedBy } });
    await appendAudit(tx, {
      actorType: 'OPERATOR', actorRef: provisionedBy, targetUserId: user.id,
      action: 'platform_admin.granted', entityType: 'PlatformAdmin', entityId: user.id
    });
    return { userId: user.id, created: true };
  });
}
