import { createHash, randomBytes } from 'node:crypto';
import { legacyUidHash } from './identity.js';

export const invitationHash = token => createHash('sha256').update(token).digest('hex');

export async function createInvitation(tx, input) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + input.expiresInDays * 86400000);
  const invitation = await tx.organizationInvitation.create({
    data: {
      organizationId: input.organizationId,
      type: input.type,
      role: input.role || null,
      trainerUserId: input.trainerUserId || null,
      targetLegacyUid: input.targetLegacyUid || null,
      targetLegacyUidHash: input.targetLegacyUid ? legacyUidHash(input.targetLegacyUid) : null,
      createdByUserId: input.createdByUserId,
      createdByPlatformAdmin: !!input.createdByPlatformAdmin,
      tokenHash: invitationHash(token),
      expiresAt
    }
  });
  return { invitation, token };
}
