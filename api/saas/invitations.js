import { createHash, randomBytes, randomInt } from 'node:crypto';
import { legacyUidHash } from './identity.js';
import { invitationCodeHash } from './email-security.js';

export const invitationHash = token => createHash('sha256').update(token).digest('hex');

export async function createInvitation(tx, input, secret) {
  const token = randomBytes(32).toString('base64url');
  let code = null, codeHash = null;
  if (input.targetEmail) {
    if (!secret) throw new Error('invitation code secret is unavailable');
    for (let tries = 0; tries < 5; tries++) {
      code = String(randomInt(0, 1000000)).padStart(6, '0');
      codeHash = invitationCodeHash(secret, input.targetEmail, code);
      const duplicate = await tx.organizationInvitation.findFirst?.({ where: { invitationCodeHash: codeHash } });
      if (!duplicate) break;
      code = null;
    }
    if (!code) throw new Error('could not generate a unique invitation code');
  }
  const expiresAt = new Date(Date.now() + input.expiresInDays * 86400000);
  const invitation = await tx.organizationInvitation.create({
    data: {
      organizationId: input.organizationId,
      type: input.type,
      role: input.role || null,
      trainerUserId: input.trainerUserId || null,
      targetLegacyUid: input.targetLegacyUid || null,
      targetLegacyUidHash: input.targetLegacyUid ? legacyUidHash(input.targetLegacyUid) : null,
      targetEmail: input.targetEmail || null,
      invitationCodeHash: codeHash,
      createdByUserId: input.createdByUserId,
      createdByPlatformAdmin: !!input.createdByPlatformAdmin,
      tokenHash: invitationHash(token),
      expiresAt
    }
  });
  return { invitation, token, code };
}

export async function rotateInvitation(tx, invitation, secret) {
  const token = randomBytes(32).toString('base64url');
  let code = null, codeHash = null;
  if (invitation.targetEmail) {
    for (let tries = 0; tries < 5; tries++) {
      code = String(randomInt(0, 1000000)).padStart(6, '0');
      codeHash = invitationCodeHash(secret, invitation.targetEmail, code);
      const duplicate = await tx.organizationInvitation.findFirst?.({ where: { invitationCodeHash: codeHash, id: { not: invitation.id } } });
      if (!duplicate) break;
      code = null;
    }
    if (!code) throw new Error('could not generate a unique invitation code');
  }
  const updated = await tx.organizationInvitation.update({
    where: { id: invitation.id },
    data: { tokenHash: invitationHash(token), invitationCodeHash: codeHash, deliveryStatus: 'NOT_SENT', sentAt: null, providerSubmissionId: null }
  });
  return { invitation: updated, token, code };
}
