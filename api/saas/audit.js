export function appendAudit(tx, event) {
  return tx.auditEvent.create({
    data: {
      actorType: event.actorType || 'USER',
      actorUserId: event.actorUserId || null,
      actorLegacyUid: event.actorLegacyUid || null,
      actorRef: event.actorRef || null,
      targetUserId: event.targetUserId || null,
      organizationId: event.organizationId || null,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId || null,
      metadata: event.metadata || undefined
    }
  });
}
