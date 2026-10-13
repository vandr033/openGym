import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { applyWorkoutOperation, getWorkoutSession } from '../saas/workout-sessions.js';
import { closeSaasDb, getSaasDb } from '../saas/db.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const database = new URL(process.env.DATABASE_URL);
assert.equal(database.protocol, 'mysql:');
assert.equal(decodeURIComponent(database.pathname.slice(1)), 'opengym_saas_test');
assert.ok(['localhost', '127.0.0.1', '::1'].includes(database.hostname), 'refusing a remote MySQL host');

try {
  const { actorUserId, sessionId, body } = JSON.parse(process.argv[2] || 'null');
  const db = await getSaasDb();
  const result = await applyWorkoutOperation(db, { actorUserId, sessionId, body });
  const snapshot = await getWorkoutSession(db, { actorUserId, sessionId });
  process.stdout.write(JSON.stringify({ result, snapshot: snapshot.session }));
} finally {
  await closeSaasDb();
}
