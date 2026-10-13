import fs from 'node:fs';
import path from 'node:path';
import { getSaasDb } from '../saas/db.js';
import { provisionPlatformAdmin } from '../saas/identity.js';

const [legacyUid, ...args] = process.argv.slice(2);
const byIndex = args.indexOf('--by');
const provisionedBy = byIndex >= 0 ? args[byIndex + 1] : '';

if (!legacyUid || legacyUid.length > 128 || !provisionedBy || provisionedBy.length > 128 || args.length !== 2 || byIndex !== 0) {
  console.error('usage: node scripts/provision-platform-admin.js <legacy-uid> --by <operator-id>');
  process.exit(2);
}

const dataFile = path.join(process.env.DATA_DIR || '/data', 'db.json');
const legacyDb = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const user = legacyDb.users?.find(row => row.id === legacyUid && !row.disabled);
if (!user) {
  console.error('active legacy account not found');
  process.exit(1);
}

const db = await getSaasDb();
try {
  const result = await provisionPlatformAdmin(db, user, provisionedBy);
  process.stdout.write(JSON.stringify(result) + '\n');
} finally {
  await db.$disconnect();
}
