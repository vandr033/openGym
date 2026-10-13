export const MEMBERSHIP_ROLES = ['OWNER', 'ADMIN', 'TRAINER', 'STAFF'];
export const ACCESS_SCOPES = ['VIEW_TRAINING', 'START_SESSION', 'LOG_SETS', 'MANAGE_ASSIGNMENTS', 'VIEW_BODYWEIGHT'];
export const isGrantEffective = (grant, scope, now = new Date()) =>
  grant?.scope === scope && !grant.revokedAt && grant.expiresAt instanceof Date && grant.expiresAt > now;

export async function hasPlatformAdmin(db, userId) {
  return !!await db.platformAdmin.findUnique({ where: { userId }, select: { userId: true } });
}

export async function organizationRole(db, userId, organizationId) {
  const membership = await db.organizationMembership.findFirst({
    where: {
      userId, organizationId, status: 'ACTIVE',
      organization: { status: 'ACTIVE' }, user: { status: 'ACTIVE' }
    },
    select: { role: true }
  });
  return membership?.role || null;
}

export async function canManageOrganization(db, userId, organizationId, roles = ['OWNER', 'ADMIN']) {
  return roles.includes(await organizationRole(db, userId, organizationId));
}

export async function canAccessClientScope(db, { actorUserId, clientUserId, organizationId, scope, now = new Date() }) {
  if (actorUserId === clientUserId) return true;
  const organization = await db.organization.findFirst({
    where: {
      id: organizationId, status: 'ACTIVE',
      memberships: { some: { userId: actorUserId, role: { in: ['OWNER', 'ADMIN', 'TRAINER'] }, status: 'ACTIVE', user: { status: 'ACTIVE' } } },
      enrollments: { some: { clientUserId, status: 'ACTIVE', client: { status: 'ACTIVE' } } },
      relationships: {
        some: {
          trainerUserId: actorUserId, clientUserId, status: 'ACTIVE',
          trainer: { status: 'ACTIVE' },
          grants: { some: { scope, revokedAt: null, expiresAt: { gt: now } } }
        }
      }
    },
    select: { id: true }
  });
  return !!organization;
}
