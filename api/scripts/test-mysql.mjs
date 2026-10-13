import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from '../test/helpers.mjs';

const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const connection = process.env.SAAS_TEST_DATABASE_URL;
if (!connection) throw new Error('Set SAAS_TEST_DATABASE_URL to a disposable MySQL database named opengym_saas_test.');
const url = new URL(connection);
if (url.protocol !== 'mysql:' || decodeURIComponent(url.pathname.slice(1)) !== 'opengym_saas_test') {
  throw new Error('Refusing to migrate: SAAS_TEST_DATABASE_URL must be mysql://.../opengym_saas_test.');
}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) {
  throw new Error('Refusing to migrate a remote MySQL host; use a disposable local opengym_saas_test database.');
}

process.env.DATABASE_URL = connection;
process.env.SAAS_ENABLED = '1';
process.env.SAAS_EMAIL_OTP_ENABLED = '1';
process.env.SAAS_INVITES_V2_ENABLED = '1';
process.env.INVITE_ONLY = '0';
process.env.COLLAB_WORKOUTS_ENABLED = '1';
const prismaCli = path.join(API, 'node_modules', 'prisma', 'build', 'index.js');
for (let run = 1; run <= 2; run++) {
  const migration = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: API, env: process.env, encoding: 'utf8'
  });
  if (migration.stdout) process.stdout.write(migration.stdout);
  if (migration.stderr) process.stderr.write(migration.stderr);
  if (migration.status !== 0) throw new Error(`Prisma migration deploy ${run} failed (${migration.status ?? migration.signal}).`);
}

const { getSaasDb, closeSaasDb } = await import('../saas/db.js');
const { provisionPlatformAdmin, deactivateMappedIdentity, ensureIdentity, legacyUidHash } = await import('../saas/identity.js');
const { canAccessClientScope } = await import('../saas/policy.js');
const { matchSaasRoute, saasRoutes } = await import('../saas/routes.js');
const { emailAuthRoutes } = await import('../saas/email-auth-routes.js');
const { emailOtpStepUpProof } = await import('../saas/email-security.js');
let db = await getSaasDb();
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
function assertHttpStatus(response, expected, message, fixtures) {
  assert.equal(response.statusCode, expected,
    `${message}; response=${JSON.stringify(response.body)}; fixtures=${JSON.stringify(fixtures)}`);
}
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
const { workoutSessionRoutes } = await import('../saas/workout-routes.js?mysql-integration');
const workoutRoutes = workoutSessionRoutes({
  json: (res, statusCode, body) => { res.statusCode = statusCode; res.body = body; },
  readBody: req => req.body,
  readSession: req => req.sessionUser || null,
  getDb: async () => db,
  legacyUserById: id => users.get(id) || null
});
let activeWorkoutRequests = 0, maxConcurrentWorkoutRequests = 0;
async function workoutRequest(method, pathname, sessionUser, body) {
  const url = new URL(pathname, 'http://x');
  const match = matchSaasRoute(workoutRoutes, method, url.pathname);
  assert.ok(match, `missing workout route: ${method} ${pathname}`);
  const res = apiResponse();
  activeWorkoutRequests++;
  maxConcurrentWorkoutRequests = Math.max(maxConcurrentWorkoutRequests, activeWorkoutRequests);
  try {
    await workoutRoutes[match.key]({ sessionUser, body, url: pathname, saasParams: match.params }, res);
    return res;
  } finally {
    activeWorkoutRequests--;
  }
}
function sessionFixtureState(session) {
  return {
    id: session?.id, status: session?.status, version: session?.version,
    exercises: session?.exercises?.map(exercise => ({
      id: exercise.id, exerciseId: exercise.exerciseId, position: exercise.position,
      sets: exercise.sets?.map(set => ({
        id: set.id, plannedSetSlotId: set.plannedSetSlotId, position: set.position,
        deletedAt: set.deletedAt, version: set.version
      }))
    }))
  };
}
async function startStepUpServer(users, secret) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-email-step-up-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users, creds: [], subs: [], invites: [] }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, DATABASE_URL: connection,
      SAAS_ENABLED: '1', SAAS_EMAIL_OTP_ENABLED: '1', SAAS_INVITES_V2_ENABLED: '1',
      PASSWORD_LOGIN: '0', ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' }
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    const port = await boundPort(child, () => output);
    return {
      api: `http://127.0.0.1:${port}`,
      cookie(uid, version = 0) {
        const payload = `${uid}:${Date.now() + 86400000}:${version}`;
        return `gymsid=${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
      },
      async post(pathname, body, cookie) {
        const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Cookie: cookie },
          body: JSON.stringify(body)
        });
        return { status: response.status, body: await response.json() };
      },
      close() {
        child.kill('SIGKILL');
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    };
  } catch (error) {
    child.kill('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
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
  const jsonAccounts = new Map();
  let verificationCode = null, interruptJsonWrite = true;
  const emailRoutes = emailAuthRoutes({
    json: (res, statusCode, body) => { res.statusCode = statusCode; res.body = body; },
    readBody: req => req.body, readSession: () => null, getDb: async () => db,
    secret: `mysql-email-test-${suffix}`,
    emailDelivery: { configured: true, send: async mail => {
      verificationCode = mail.text.match(/\b(\d{6})\b/)?.[1] || null;
      return { status: 'SIMULATED' };
    } },
    limitAddress: () => '127.0.0.1',
    legacyUserById: id => jsonAccounts.get(id) || users.get(id) || null,
    legacyUserWithEmail: email => [...jsonAccounts.values()].find(user => user.email === email) || null,
    createLegacyEmailAccount: async ({ id, name, challengeId }) => {
      if (interruptJsonWrite) { interruptJsonWrite = false; throw new Error('simulated JSON-store interruption'); }
      let user = jsonAccounts.get(id);
      if (user && user.emailOtpChallengeId !== challengeId) throw new Error('email account recovery mismatch');
      if (!user) {
        user = { id, name, emailOtpChallengeId: challengeId };
        jsonAccounts.set(id, user);
      }
      delete user.emailOtpChallengeId;
      return user;
    },
    loginResponse: (_req, res, user, extra = {}) => {
      res.statusCode = 200; res.body = { user, ...extra };
    },
    proveOwner: async () => 'test-proof', inviteOnly: false
  });
  const emailRequest = async (method, body) => {
    const res = {};
    await emailRoutes[method]({ body, headers: {} }, res);
    return res;
  };
  const testEmail = `mysql-${suffix}@example.test`;
  const issued = await emailRequest('POST /api/v2/auth/email/request', { email: testEmail, purpose: 'INVITATION' });
  assert.equal(issued.statusCode, 202, JSON.stringify(issued.body));
  assert.match(verificationCode, /^\d{6}$/);
  const claims = await Promise.all([1, 2].map(() => emailRequest('POST /api/v2/auth/email/verify', {
    challengeId: issued.body.challengeId, code: verificationCode
  })));
  assert.deepEqual(claims.map(result => result.statusCode).sort(), [200, 400], 'MySQL compare-and-swap allows one concurrent OTP redemption');

  const signupIssued = await emailRequest('POST /api/v2/auth/email/request', { email: `signup-${suffix}@example.test`, purpose: 'INVITATION' });
  assert.equal(signupIssued.statusCode, 202, JSON.stringify(signupIssued.body));
  const signupCode = verificationCode;
  const signupVerified = await emailRequest('POST /api/v2/auth/email/verify', {
    challengeId: signupIssued.body.challengeId, code: signupCode
  });
  assert.equal(signupVerified.statusCode, 200, JSON.stringify(signupVerified.body));
  assert.equal(signupVerified.body.status, 'registration_required');
  const registrationState = signupVerified.body.registrationState;
  const signupChallenge = await db.emailOtpChallenge.findUnique({ where: { id: signupIssued.body.challengeId } });
  const complete = () => emailRequest('POST /api/v2/onboarding/complete', {
    registrationState, name: 'MySQL OTP onboarding', preferences: { unit: 'kg', lang: 'en' }
  });
  const interrupted = await complete();
  assert.equal(interrupted.statusCode, 503, 'JSON write interruption happens after the SQL onboarding transaction commits');
  const committedIdentity = await db.verifiedEmailIdentity.findUnique({ where: { email: `signup-${suffix}@example.test` }, include: { user: true } });
  assert.equal(committedIdentity?.user?.legacyUid, signupChallenge.registrationUid);
  assert.ok((await db.emailOtpChallenge.findUnique({ where: { id: signupChallenge.id } })).completedAt);
  const recovered = await complete();
  assert.equal(recovered.statusCode, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.user.id, signupChallenge.registrationUid);
  const retried = await complete();
  assert.equal(retried.statusCode, 200, JSON.stringify(retried.body));
  assert.equal(jsonAccounts.size, 1, 'onboarding retries reuse one legacy account');
  const secondIdentityUser = makeUser('SaaS duplicate e-mail constraint probe');
  const secondIdentityActor = await ensureIdentity(db, secondIdentityUser);
  await assert.rejects(db.verifiedEmailIdentity.create({ data: {
    userId: secondIdentityActor.id, email: `signup-${suffix}@example.test`, verifiedAt: new Date(), source: 'test'
  } }), error => error?.code === 'P2002', 'a verified e-mail can belong to only one SQL identity');
  await assert.rejects(db.verifiedEmailIdentity.create({ data: {
    userId: committedIdentity.user.id, email: `another-${suffix}@example.test`, verifiedAt: new Date(), source: 'test'
  } }), error => error?.code === 'P2002', 'a SQL identity can own only one verified e-mail');

  const stepUser = makeUser('MySQL email step-up user');
  const otherStepUser = makeUser('MySQL other step-up user');
  const stepIdentity = await ensureIdentity(db, stepUser);
  const stepEmail = `step-up-${suffix}@example.test`;
  await db.verifiedEmailIdentity.create({ data: {
    userId: stepIdentity.id, email: stepEmail, verifiedAt: new Date(), source: 'test'
  } });
  const stepSecret = randomBytes(32).toString('hex');
  const addStepChallenge = (overrides = {}) => db.emailOtpChallenge.create({ data: {
    id: randomUUID(), email: stepEmail, purpose: 'PASSKEY_ADD', codeHash: '0'.repeat(64),
    legacyUid: stepUser.id, sessionVersion: 0, attempts: 0, expiresAt: new Date(Date.now() + 60000),
    verifiedAt: new Date(), consumedAt: new Date(), deliveryStatus: 'SIMULATED', ...overrides
  } });
  const stepServer = await startStepUpServer([stepUser, otherStepUser], stepSecret);
  try {
    const stepChallenge = await addStepChallenge();
    const stepProof = emailOtpStepUpProof(stepSecret, {
      challengeId: stepChallenge.id, uid: stepUser.id, email: stepEmail, sv: 0, exp: Date.now() + 60000
    });
    const simultaneous = await Promise.all([1, 2].map(() => stepServer.post(
      '/api/account/passkeys/options', { emailProof: stepProof }, stepServer.cookie(stepUser.id)
    )));
    assert.deepEqual(simultaneous.map(result => result.status).sort(), [200, 403], 'MySQL step-up claim is single-use under concurrent passkey-option requests');
    assert.equal((await db.emailOtpChallenge.findUnique({ where: { id: stepChallenge.id } })).completedAt instanceof Date, true);

    const wrongOwnerChallenge = await addStepChallenge();
    const wrongOwnerProof = emailOtpStepUpProof(stepSecret, {
      challengeId: wrongOwnerChallenge.id, uid: otherStepUser.id, email: stepEmail, sv: 0, exp: Date.now() + 60000
    });
    const wrongOwner = await stepServer.post('/api/account/passkeys/options', { emailProof: wrongOwnerProof }, stepServer.cookie(otherStepUser.id));
    assert.equal(wrongOwner.status, 403, 'another account cannot spend the first user’s verified-email challenge');
    assert.equal((await db.emailOtpChallenge.findUnique({ where: { id: wrongOwnerChallenge.id } })).completedAt, null);

    const expiredChallenge = await addStepChallenge({ expiresAt: new Date(Date.now() - 1000) });
    const expiredProof = emailOtpStepUpProof(stepSecret, {
      challengeId: expiredChallenge.id, uid: stepUser.id, email: stepEmail, sv: 0, exp: Date.now() + 60000
    });
    const expired = await stepServer.post('/api/account/passkeys/options', { emailProof: expiredProof }, stepServer.cookie(stepUser.id));
    assert.equal(expired.status, 403, 'an expired SQL OTP challenge cannot step up');

    const revokedChallenge = await addStepChallenge();
    const revokedProof = emailOtpStepUpProof(stepSecret, {
      challengeId: revokedChallenge.id, uid: stepUser.id, email: stepEmail, sv: 0, exp: Date.now() + 60000
    });
    const oldCookie = stepServer.cookie(stepUser.id);
    assert.equal((await stepServer.post('/api/logout/all', {}, oldCookie)).status, 200);
    assert.equal((await stepServer.post('/api/account/passkeys/options', { emailProof: revokedProof }, oldCookie)).status, 401,
      'signing out everywhere revokes the old session');
    assert.equal((await stepServer.post('/api/account/passkeys/options', { emailProof: revokedProof }, stepServer.cookie(stepUser.id, 1))).status, 403,
      'a new session version cannot redeem an old session-bound OTP proof');
    assert.equal((await db.emailOtpChallenge.findUnique({ where: { id: revokedChallenge.id } })).completedAt, null);
  } finally {
    stepServer.close();
  }

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
  const ownerAcceptance = await accept(owner, ownerInvitation.token);
  assert.equal(ownerAcceptance.statusCode, 200);
  const repeatedOwnerAcceptance = await accept(owner, ownerInvitation.token);
  assert.equal(repeatedOwnerAcceptance.statusCode, 200, 'the same user can safely recover an accepted invitation');
  assert.equal(repeatedOwnerAcceptance.body.membership.id, ownerAcceptance.body.membership.id, 'repeated acceptance does not duplicate membership');
  assert.equal((await accept(trainer, ownerInvitation.token)).statusCode, 404, 'another user cannot reuse the accepted invitation');

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

  const phase2Owner = makeUser('SaaS Phase 2 owner');
  const phase2Trainer = makeUser('SaaS Phase 2 trainer');
  const phase2Client = makeUser('SaaS Phase 2 client');
  const phase2ClientToStart = makeUser('SaaS Phase 2 start-only client');
  assert.notEqual(phase2Trainer.id, trainer.id);
  assert.notEqual(phase2Client.id, client.id);
  assert.notEqual(phase2ClientToStart.id, phase2Client.id);
  const phase2OrganizationResponse = await request('POST', '/api/v2/platform/organizations', platform, {
    type: 'GYM', name: 'SaaS Phase 2 Workout Gym', slug: `saas-it-workout-${suffix}`, ownerLegacyUid: phase2Owner.id
  });
  assert.equal(phase2OrganizationResponse.statusCode, 201, JSON.stringify(phase2OrganizationResponse.body));
  const phase2Organization = phase2OrganizationResponse.body.organization;
  assert.equal((await accept(phase2Owner, phase2OrganizationResponse.body.ownerInvitation.token)).statusCode, 200);
  const phase2TrainerInvite = await request('POST', `/api/v2/organizations/${phase2Organization.id}/members/invitations`, phase2Owner, { role: 'TRAINER' });
  assert.equal(phase2TrainerInvite.statusCode, 201, JSON.stringify(phase2TrainerInvite.body));
  assert.equal((await accept(phase2Trainer, phase2TrainerInvite.body.token)).statusCode, 200);
  const phase2ClientInvite = await request('POST', `/api/v2/organizations/${phase2Organization.id}/clients/invitations`, phase2Trainer, { clientLegacyUid: phase2Client.id });
  assert.equal(phase2ClientInvite.statusCode, 201, JSON.stringify(phase2ClientInvite.body));
  const phase2Relationship = await enrollClient(phase2Client, phase2Organization.id, phase2ClientInvite.body.token);
  const phase2StartClientInvite = await request('POST', `/api/v2/organizations/${phase2Organization.id}/clients/invitations`, phase2Trainer, { clientLegacyUid: phase2ClientToStart.id });
  assert.equal(phase2StartClientInvite.statusCode, 201, JSON.stringify(phase2StartClientInvite.body));
  const phase2StartRelationship = await enrollClient(phase2ClientToStart, phase2Organization.id, phase2StartClientInvite.body.token);

  const phase2TrainerSql = await db.user.findUnique({ where: { legacyUidHash: legacyUidHash(phase2Trainer.id) } });
  const phase2ClientSql = await db.user.findUnique({ where: { legacyUidHash: legacyUidHash(phase2Client.id) } });
  const phase2StartClientSql = await db.user.findUnique({ where: { legacyUidHash: legacyUidHash(phase2ClientToStart.id) } });
  assert.ok(phase2TrainerSql && phase2ClientSql && phase2StartClientSql,
    `Phase 2 identities were not provisioned: ${JSON.stringify({ organization: phase2Organization, trainer: phase2TrainerSql, client: phase2ClientSql, startClient: phase2StartClientSql })}`);
  const phase2TrainerMembership = await db.organizationMembership.findUnique({ where: {
    organizationId_userId: { organizationId: phase2Organization.id, userId: phase2TrainerSql.id }
  } });
  const phase2ClientEnrollment = await db.clientOrganizationEnrollment.findUnique({ where: {
    organizationId_clientUserId: { organizationId: phase2Organization.id, clientUserId: phase2ClientSql.id }
  } });
  const phase2StartClientEnrollment = await db.clientOrganizationEnrollment.findUnique({ where: {
    organizationId_clientUserId: { organizationId: phase2Organization.id, clientUserId: phase2StartClientSql.id }
  } });
  const phase2RelationshipRow = await db.trainerClientRelationship.findUnique({ where: { id: phase2Relationship.id } });
  const phase2StartRelationshipRow = await db.trainerClientRelationship.findUnique({ where: { id: phase2StartRelationship.id } });
  const phase2FixtureState = {
    organization: { id: phase2Organization.id, status: phase2Organization.status },
    trainer: {
      legacyUid: phase2Trainer.id, userId: phase2TrainerSql.id, status: phase2TrainerSql.status,
      membership: { id: phase2TrainerMembership?.id, role: phase2TrainerMembership?.role, status: phase2TrainerMembership?.status }
    },
    client: {
      legacyUid: phase2Client.id, userId: phase2ClientSql.id, status: phase2ClientSql.status,
      enrollment: { id: phase2ClientEnrollment?.id, status: phase2ClientEnrollment?.status },
      relationship: { id: phase2RelationshipRow?.id, status: phase2RelationshipRow?.status }
    },
    startClient: {
      legacyUid: phase2ClientToStart.id, userId: phase2StartClientSql.id, status: phase2StartClientSql.status,
      enrollment: { id: phase2StartClientEnrollment?.id, status: phase2StartClientEnrollment?.status },
      relationship: { id: phase2StartRelationshipRow?.id, status: phase2StartRelationshipRow?.status }
    }
  };
  assert.ok(phase2TrainerMembership && phase2ClientEnrollment && phase2StartClientEnrollment && phase2RelationshipRow && phase2StartRelationshipRow,
    `Phase 2 relational fixtures were not provisioned: ${JSON.stringify(phase2FixtureState)}`);
  assert.equal(phase2FixtureState.organization.status, 'ACTIVE', JSON.stringify(phase2FixtureState));
  assert.equal(phase2FixtureState.trainer.status, 'ACTIVE', JSON.stringify(phase2FixtureState));
  assert.equal(phase2FixtureState.trainer.membership.status, 'ACTIVE', JSON.stringify(phase2FixtureState));
  assert.equal(phase2FixtureState.trainer.membership.role, 'TRAINER', JSON.stringify(phase2FixtureState));
  assert.equal(phase2FixtureState.client.status, 'ACTIVE', JSON.stringify(phase2FixtureState));
  assert.equal(phase2FixtureState.client.enrollment.status, 'ACTIVE', JSON.stringify(phase2FixtureState));
  assert.equal(phase2FixtureState.client.relationship.status, 'ACTIVE', JSON.stringify(phase2FixtureState));
  assert.equal(phase2FixtureState.startClient.status, 'ACTIVE', JSON.stringify(phase2FixtureState));
  assert.equal(phase2FixtureState.startClient.enrollment.status, 'ACTIVE', JSON.stringify(phase2FixtureState));
  assert.equal(phase2FixtureState.startClient.relationship.status, 'ACTIVE', JSON.stringify(phase2FixtureState));

  const sessionPath = sessionId => `/api/v2/workout-sessions/${sessionId}`;
  const operation = (type, target, patch, versions = {}) => ({ operationId: randomUUID(), type, target, patch, ...versions });
  maxConcurrentWorkoutRequests = 0;
  const starts = await Promise.all([1, 2].map(() => workoutRequest(
    'POST', `/api/v2/clients/${phase2Client.id}/workout-sessions`, phase2Client, {
      operationId: randomUUID(), organizationId: phase2Organization.id,
      routineSnapshot: {
        id: 'strength-day', name: 'Deload strength day', deload: true,
        deloadMetadata: { percent: 50, reason: 'recovery week' }, program: { phase: 2 },
        exercises: [
          {
            exerciseId: 'barbell-row', name: 'Barbell row', routineSlotId: 'row-slot', noProgression: true,
            snapshot: { id: 'barbell-row', name: 'Barbell row', sg: 'A', mode: 'reps' },
            prescription: { sets: 2, reps: 8 }, notes: 'Keep torso still',
            sets: [
              { plannedSetSlotId: 'row-warmup', position: 0, phase: 'WARMUP', weightKg: '60.000', reps: 8, rir: '1.5', notes: 'warm-up', done: true,
                details: { schemaVersion: 1, mode: 'reps', perSide: true, assistedKg: '5.000', sides: { L: { weightKg: '60.125', reps: 8, rir: '1.5', done: true }, R: { weightKg: '59.875', reps: 8, rpe: '8.0', done: true } } } },
              { plannedSetSlotId: 'row-work', position: 1, phase: 'WORK', weightKg: '80.250', reps: 10, rpe: '8.5', done: true,
                details: { schemaVersion: 1, mode: 'reps', type: 'dropset', drops: [{ weightKg: '70.500', reps: 8 }], clusters: [{ reps: 2, restSeconds: 15 }] } },
              { position: 2, phase: 'WORK', durationSeconds: 30, notes: 'Rest-pause finisher', details: { schemaVersion: 1, mode: 'time', type: 'restpause', clusters: [{ reps: 3, restSeconds: 20 }] } }
            ]
          },
          {
            exerciseId: 'treadmill-run', name: 'Treadmill run', routineSlotId: 'cardio-slot', snapshot: { id: 'treadmill-run', name: 'Treadmill run' },
            sets: [{ phase: 'WORK', durationSeconds: 900, details: { schemaVersion: 1, mode: 'cardio', speedKph: '10.50', distanceKm: '2.625', status: 'complete' } }]
          }
        ]
      }
    }
  )));
  assert.deepEqual(starts.map(row => row.statusCode).sort(), [200, 201],
    `parallel workout starts; responses=${JSON.stringify(starts.map(row => row.body))}; fixtures=${JSON.stringify(phase2FixtureState)}`);
  assert.ok(maxConcurrentWorkoutRequests >= 2, `session starts did not overlap: peak=${maxConcurrentWorkoutRequests}`);
  assert.ok(starts.every(row => row.body.session?.id),
    `parallel workout starts returned no session: responses=${JSON.stringify(starts.map(row => row.body))}; fixtures=${JSON.stringify(phase2FixtureState)}`);
  const sessionId = starts[0].body.session.id;
  assert.equal(starts[1].body.session.id, sessionId, 'parallel starts converge on one active SQL session');
  assert.equal(await db.clientActiveSession.count({ where: { clientUserId: phase2ClientSql.id } }), 1);
  const activeSessionResponse = await workoutRequest('GET', `/api/v2/clients/${phase2Client.id}/workout-sessions/active`, phase2Client);
  assertHttpStatus(activeSessionResponse, 200, 'client reads active session', phase2FixtureState);
  assert.equal(activeSessionResponse.body.session?.id, sessionId,
    `active session does not match concurrent start: response=${JSON.stringify(activeSessionResponse.body)}; expectedSessionId=${sessionId}`);
  const initialSnapshotResponse = await workoutRequest('GET', sessionPath(sessionId), phase2Client);
  assertHttpStatus(initialSnapshotResponse, 200, 'client reads the newly created session', phase2FixtureState);
  let snapshot = initialSnapshotResponse.body.session;
  assert.ok(snapshot && Array.isArray(snapshot.exercises),
    `created session snapshot has no exercises: response=${JSON.stringify(initialSnapshotResponse.body)}; fixtures=${JSON.stringify(phase2FixtureState)}`);
  const barbellRowExercise = snapshot.exercises.find(exercise => exercise.exerciseId === 'barbell-row');
  const treadmillExercise = snapshot.exercises.find(exercise => exercise.exerciseId === 'treadmill-run');
  const initialSessionState = JSON.stringify(sessionFixtureState(snapshot));
  assert.ok(barbellRowExercise && treadmillExercise,
    `created session is missing a fixture exercise: ${initialSessionState}; fixtures=${JSON.stringify(phase2FixtureState)}`);
  const barbellRowExerciseId = barbellRowExercise.id;
  const rowA = barbellRowExercise.sets?.find(set => set.plannedSetSlotId === 'row-warmup' && !set.deletedAt);
  const rowB = barbellRowExercise.sets?.find(set => set.plannedSetSlotId === 'row-work' && !set.deletedAt);
  const finisherSet = barbellRowExercise.sets?.find(set => set.durationSeconds === 30 && !set.deletedAt);
  const cardioSet = treadmillExercise.sets?.[0];
  assert.ok(rowA && rowB && finisherSet && cardioSet,
    `created session is missing expected sets: ${initialSessionState}; fixtures=${JSON.stringify(phase2FixtureState)}`);
  assert.equal(snapshot.routineSnapshot.deload, true);
  assert.equal(snapshot.routineSnapshot.deloadMetadata.percent, 50);
  assert.equal(barbellRowExercise.noProgression, true);
  assert.equal(barbellRowExercise.snapshot.sg, 'A');
  assert.equal(rowA.phase, 'WARMUP');
  assert.equal(rowA.weightKg, '60');
  assert.equal(rowA.rir, '1.5');
  assert.equal(rowA.notes, 'warm-up');
  assert.equal(rowA.details.data.assistedKg, '5');
  assert.equal(rowA.details.data.sides.L.weightKg, '60.125');
  assert.equal(rowB.rpe, '8.5');
  assert.equal(rowB.details.data.drops[0].weightKg, '70.5');
  assert.equal(finisherSet.details.data.clusters[0].restSeconds, 20);
  assert.equal(cardioSet.durationSeconds, 900);
  assert.equal(cardioSet.details.data.distanceKm, '2.625');

  const sessionUrl = sessionPath(sessionId);
  assertHttpStatus(await workoutRequest('GET', sessionUrl, platform), 404, 'PlatformAdmin has no client workout read access', phase2FixtureState);
  assertHttpStatus(await workoutRequest('GET', sessionUrl, phase2Trainer), 404, 'trainer has no access without a current VIEW_TRAINING grant', phase2FixtureState);
  assertHttpStatus(await workoutRequest('GET', sessionUrl, otherOwner), 404, 'another organization owner cannot read this workout', phase2FixtureState);
  const viewOnly = await request('PUT', `/api/v2/coaching/relationships/${phase2Relationship.id}/grants`, phase2Client, {
    scopes: ['VIEW_TRAINING'], expiresAt: new Date(Date.now() + 86400000).toISOString()
  });
  assertHttpStatus(viewOnly, 200, 'client VIEW_TRAINING consent', phase2FixtureState);
  assertHttpStatus(await workoutRequest('GET', sessionUrl, phase2Trainer), 200, 'trainer reads after VIEW_TRAINING consent', phase2FixtureState);
  const forbiddenWrite = await workoutRequest('POST', `${sessionUrl}/operations`, phase2Trainer,
    operation('set.update', { setId: rowA.id }, { reps: 9 }, { expectedSetVersion: rowA.version }));
  assertHttpStatus(forbiddenWrite, 404, 'VIEW_TRAINING does not imply LOG_SETS', phase2FixtureState);
  const logGrant = await request('PUT', `/api/v2/coaching/relationships/${phase2Relationship.id}/grants`, phase2Client, {
    scopes: ['VIEW_TRAINING', 'LOG_SETS'], expiresAt: new Date(Date.now() + 86400000).toISOString()
  });
  assertHttpStatus(logGrant, 200, 'client VIEW_TRAINING and LOG_SETS consent', phase2FixtureState);

  maxConcurrentWorkoutRequests = 0;
  const trainerSetWrites = await Promise.all([
    workoutRequest('POST', `${sessionUrl}/operations`, phase2Trainer,
      operation('set.update', { setId: rowA.id }, { weightKg: '61.125' }, { expectedSetVersion: rowA.version })),
    workoutRequest('POST', `${sessionUrl}/operations`, phase2Trainer,
      operation('set.update', { setId: rowB.id }, { reps: 11 }, { expectedSetVersion: rowB.version }))
  ]);
  assert.ok(maxConcurrentWorkoutRequests >= 2, `independent set writes did not overlap: peak=${maxConcurrentWorkoutRequests}`);
  assert.deepEqual(trainerSetWrites.map(row => row.statusCode), [200, 200],
    `independent set writes; responses=${JSON.stringify(trainerSetWrites.map(row => row.body))}; fixtures=${JSON.stringify(phase2FixtureState)}`);
  const afterWriteSnapshotResponse = await workoutRequest('GET', sessionUrl, phase2Client);
  assertHttpStatus(afterWriteSnapshotResponse, 200, 'read session after concurrent set writes', phase2FixtureState);
  snapshot = afterWriteSnapshotResponse.body.session;
  const barbellRowAfterWrites = snapshot.exercises.find(exercise => exercise.id === barbellRowExerciseId);
  assert.ok(barbellRowAfterWrites, `barbell-row missing after set writes: ${JSON.stringify(sessionFixtureState(snapshot))}`);
  const updatedA = barbellRowAfterWrites.sets?.find(row => row.id === rowA.id && !row.deletedAt);
  const updatedB = barbellRowAfterWrites.sets?.find(row => row.id === rowB.id && !row.deletedAt);
  assert.ok(updatedA && updatedB,
    `set write fixtures missing after writes: ${JSON.stringify(sessionFixtureState(snapshot))}; expected=${JSON.stringify({ rowA: rowA.id, rowB: rowB.id })}`);
  maxConcurrentWorkoutRequests = 0;
  const sameSetRace = await Promise.all([1, 2].map(index => workoutRequest(
    'POST', `${sessionUrl}/operations`, phase2Trainer,
    operation('set.update', { setId: updatedA.id }, { reps: 12 + index }, { expectedSetVersion: updatedA.version })
  )));
  assert.ok(maxConcurrentWorkoutRequests >= 2, `same-set writes did not overlap: peak=${maxConcurrentWorkoutRequests}`);
  assert.deepEqual(sameSetRace.map(row => row.statusCode).sort(), [200, 409],
    `same-set race; responses=${JSON.stringify(sameSetRace.map(row => row.body))}; fixture=${JSON.stringify({ set: updatedA, session: sessionFixtureState(snapshot) })}`);
  const versionConflict = sameSetRace.find(row => row.statusCode === 409);
  assert.equal(versionConflict.body.code, 'VERSION_CONFLICT');
  assert.equal(versionConflict.body.currentVersion, updatedA.version + 1);
  assert.equal(versionConflict.body.current.version, updatedA.version + 1);
  assert.ok(versionConflict.body.latestSessionSequence);

  const duplicateBody = operation('set.create', { exerciseId: barbellRowExerciseId }, {
    phase: 'WORK', weightKg: '32.500', reps: 10, details: { schemaVersion: 1, mode: 'reps' }
  });
  const duplicateFirst = await workoutRequest('POST', `${sessionUrl}/operations`, phase2Trainer, duplicateBody);
  assertHttpStatus(duplicateFirst, 200, 'create set for idempotency replay', { fixtures: phase2FixtureState, session: sessionFixtureState(snapshot) });
  const restart = spawnSync(process.execPath, [path.join(API, 'scripts', 'test-workout-restart.mjs'), JSON.stringify({
    actorUserId: phase2TrainerSql.id, sessionId, body: duplicateBody
  })], { cwd: API, env: process.env, encoding: 'utf8' });
  assert.equal(restart.status, 0, restart.stderr || restart.stdout);
  const restarted = JSON.parse(restart.stdout);
  assert.deepEqual(restarted.result, duplicateFirst.body, 'idempotent replay returns the durable response from a fresh process');
  const restartedSnapshotResponse = await workoutRequest('GET', sessionUrl, phase2Trainer);
  assertHttpStatus(restartedSnapshotResponse, 200, 'trainer reads session after fresh-process replay', phase2FixtureState);
  assert.deepEqual(restarted.snapshot, JSON.parse(JSON.stringify(restartedSnapshotResponse.body.session)),
    'the authoritative snapshot is complete after a fresh process opens the database');
  const changedDuplicate = await workoutRequest('POST', `${sessionUrl}/operations`, phase2Trainer, {
    ...duplicateBody, patch: { ...duplicateBody.patch, reps: 99 }
  });
  assert.equal(changedDuplicate.statusCode, 409);
  assert.equal(changedDuplicate.body.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(await db.workoutOperation.count({ where: { sessionId, operationId: duplicateBody.operationId } }), 1);
  assert.equal(await db.workoutEvent.count({ where: { sessionId, operationId: duplicateBody.operationId } }), 1);

  const plannedSlotId = 'planned-slot-race';
  maxConcurrentWorkoutRequests = 0;
  const plannedCreates = await Promise.all([1, 2].map(() => workoutRequest('POST', `${sessionUrl}/operations`, phase2Trainer,
    operation('set.create', { exerciseId: barbellRowExerciseId }, { plannedSetSlotId: plannedSlotId, weightKg: '40', reps: 8 }))));
  assert.ok(maxConcurrentWorkoutRequests >= 2, `planned-slot writes did not overlap: peak=${maxConcurrentWorkoutRequests}`);
  assert.deepEqual(plannedCreates.map(row => row.statusCode).sort(), [200, 409],
    `planned-slot race; responses=${JSON.stringify(plannedCreates.map(row => row.body))}; fixtures=${JSON.stringify(phase2FixtureState)}`);
  assert.equal(plannedCreates.find(row => row.statusCode === 409)?.body.code, 'PLANNED_SET_EXISTS',
    `planned-slot conflict response; responses=${JSON.stringify(plannedCreates.map(row => row.body))}`);
  assert.equal(await db.workoutSet.count({ where: { sessionExerciseId: barbellRowExerciseId, plannedSetSlotId: plannedSlotId } }), 1,
    `exactly one row for planned slot ${plannedSlotId} on exercise ${barbellRowExerciseId}`);

  const beforeDeleteResponse = await workoutRequest('GET', sessionUrl, phase2Client);
  assertHttpStatus(beforeDeleteResponse, 200, 'read session before deleting a set', phase2FixtureState);
  const beforeDeleteSession = beforeDeleteResponse.body.session;
  const beforeDeleteExercise = beforeDeleteSession.exercises.find(exercise => exercise.id === barbellRowExerciseId);
  assert.ok(beforeDeleteExercise, `barbell-row missing before deleting a set: ${JSON.stringify(sessionFixtureState(beforeDeleteSession))}`);
  const deleteTarget = beforeDeleteExercise.sets?.find(row => row.id === updatedB.id && !row.deletedAt);
  assert.ok(deleteTarget, `target work set missing before delete: ${JSON.stringify(sessionFixtureState(beforeDeleteSession))}; target=${updatedB.id}`);
  const deletion = await workoutRequest('POST', `${sessionUrl}/operations`, phase2Trainer,
    operation('set.delete', { setId: deleteTarget.id }, {}, { expectedSetVersion: deleteTarget.version }));
  assert.equal(deletion.statusCode, 200);
  const staleUpdate = await workoutRequest('POST', `${sessionUrl}/operations`, phase2Trainer,
    operation('set.update', { setId: deleteTarget.id }, { reps: 20 }, { expectedSetVersion: deleteTarget.version }));
  assert.equal(staleUpdate.statusCode, 409);
  assert.equal(staleUpdate.body.code, 'VERSION_CONFLICT');
  assert.ok(staleUpdate.body.current.deletedAt, 'a stale update cannot resurrect a tombstoned set');

  const beforeAddSnapshotResponse = await workoutRequest('GET', sessionUrl, phase2Client);
  assertHttpStatus(beforeAddSnapshotResponse, 200, 'read session before adding an exercise', phase2FixtureState);
  snapshot = beforeAddSnapshotResponse.body.session;
  const addExercise = await workoutRequest('POST', `${sessionUrl}/operations`, phase2Trainer, operation(
    'exercise.add', {}, { exercise: {
      exerciseId: 'overhead-press', name: 'Overhead press', routineSlotId: 'press-slot', noProgression: true,
      snapshot: { id: 'overhead-press', name: 'Overhead press', sg: 'B' },
      sets: [{ phase: 'WORK', weightKg: '30', reps: 8 }]
    } }, { expectedSessionVersion: snapshot.version }
  ));
  assertHttpStatus(addExercise, 200, 'add overhead-press exercise', { fixtures: phase2FixtureState, session: sessionFixtureState(snapshot) });
  const addedExercise = addExercise.body.result?.exercise;
  assert.ok(addedExercise?.id,
    `added exercise fixture has no id: response=${JSON.stringify(addExercise.body)}; session=${JSON.stringify(sessionFixtureState(snapshot))}`);
  assert.equal(addedExercise.noProgression, true);
  const staleStructure = await workoutRequest('POST', `${sessionUrl}/operations`, phase2Trainer, operation(
    'exercise.reorder', { exerciseId: addedExercise.id }, { position: 0 }, { expectedSessionVersion: snapshot.version }
  ));
  assert.equal(staleStructure.statusCode, 409);
  assert.equal(staleStructure.body.code, 'VERSION_CONFLICT');
  const reorder = await workoutRequest('POST', `${sessionUrl}/operations`, phase2Trainer, operation(
    'exercise.reorder', { exerciseId: addedExercise.id }, { position: 0 }, { expectedSessionVersion: addExercise.body.version }
  ));
  assert.equal(reorder.statusCode, 200);
  const swap = await workoutRequest('POST', `${sessionUrl}/operations`, phase2Trainer, operation(
    'exercise.swap', { exerciseId: addedExercise.id }, { exercise: {
      exerciseId: 'dumbbell-overhead-press', name: 'Dumbbell overhead press', snapshot: { id: 'dumbbell-overhead-press' }, sets: []
    } }, { expectedSessionVersion: reorder.body.version }
  ));
  assert.equal(swap.statusCode, 200);
  assert.equal(swap.body.result.replacedExerciseId, addedExercise.id);
  const afterSwapResponse = await workoutRequest('GET', sessionUrl, phase2Client);
  assertHttpStatus(afterSwapResponse, 200, 'read session after exercise swap', phase2FixtureState);
  snapshot = afterSwapResponse.body.session;
  const removeTarget = snapshot.exercises.find(exercise => exercise.exerciseId === 'treadmill-run');
  assert.ok(removeTarget?.id, `treadmill fixture missing after swap: ${JSON.stringify(sessionFixtureState(snapshot))}`);
  const removedExercise = await workoutRequest('POST', `${sessionUrl}/operations`, phase2Trainer, operation(
    'exercise.remove', { exerciseId: removeTarget.id }, {}, { expectedSessionVersion: swap.body.version }
  ));
  assertHttpStatus(removedExercise, 200, 'remove treadmill exercise', { fixtures: phase2FixtureState, session: sessionFixtureState(snapshot), exerciseId: removeTarget.id });
  assert.equal(removedExercise.body.result.tombstonedSets, 1);

  await db.clientAccessGrant.updateMany({
    where: { relationshipId: phase2Relationship.id, scope: 'VIEW_TRAINING', revokedAt: null },
    data: { expiresAt: new Date(Date.now() - 1000) }
  });
  assert.equal((await workoutRequest('GET', sessionUrl, phase2Trainer)).statusCode, 404, 'an expired VIEW_TRAINING grant blocks immediately');
  const expiredLog = await workoutRequest('POST', `${sessionUrl}/operations`, phase2Trainer,
    operation('set.update', { setId: updatedA.id }, { reps: 13 }, { expectedSetVersion: updatedA.version + 1 }));
  assert.equal(expiredLog.statusCode, 200, 'the independent LOG_SETS grant remains in force when VIEW expires');

  let cursor = '0', replay = [];
  for (;;) {
    const page = await workoutRequest('GET', `${sessionUrl}/events?afterSequence=${cursor}&limit=2`, phase2Client);
    assertHttpStatus(page, 200, 'replay session events', { fixtures: phase2FixtureState, cursor });
    assert.ok(Array.isArray(page.body.events), `event page has no events array: ${JSON.stringify(page.body)}; cursor=${cursor}`);
    replay.push(...page.body.events);
    if (!page.body.hasMore) break;
    cursor = page.body.nextSequence;
  }
  assert.deepEqual(replay.map(event => event.sequence), Array.from({ length: replay.length }, (_, index) => String(index + 1)));
  const replayedSnapshotResponse = await workoutRequest('GET', sessionUrl, phase2Client);
  assertHttpStatus(replayedSnapshotResponse, 200, 'read session after event replay', phase2FixtureState);
  snapshot = replayedSnapshotResponse.body.session;
  assert.equal(snapshot.lastEventSeq, String(replay.length));

  const client2OnlyStart = await request('PUT', `/api/v2/coaching/relationships/${phase2StartRelationship.id}/grants`, phase2ClientToStart, {
    scopes: ['VIEW_TRAINING'], expiresAt: new Date(Date.now() + 86400000).toISOString()
  });
  assertHttpStatus(client2OnlyStart, 200, 'start-only client grants VIEW_TRAINING', phase2FixtureState);
  assertHttpStatus(await workoutRequest('POST', `/api/v2/clients/${phase2ClientToStart.id}/workout-sessions`, phase2Trainer, {
    operationId: randomUUID(), organizationId: phase2Organization.id
  }), 404, 'VIEW_TRAINING cannot start a session', phase2FixtureState);
  const startOnly = await request('PUT', `/api/v2/coaching/relationships/${phase2StartRelationship.id}/grants`, phase2ClientToStart, {
    scopes: ['START_SESSION'], expiresAt: new Date(Date.now() + 86400000).toISOString()
  });
  assertHttpStatus(startOnly, 200, 'start-only client grants START_SESSION', phase2FixtureState);
  const trainerStart = await workoutRequest('POST', `/api/v2/clients/${phase2ClientToStart.id}/workout-sessions`, phase2Trainer, {
    operationId: randomUUID(), organizationId: phase2Organization.id
  });
  assertHttpStatus(trainerStart, 201, 'START_SESSION alone permits creating the session', phase2FixtureState);
  assert.ok(trainerStart.body.session?.id,
    `start-only session fixture has no id: response=${JSON.stringify(trainerStart.body)}; fixtures=${JSON.stringify(phase2FixtureState)}`);
  assert.equal(trainerStart.body.session.exercises, undefined, 'START_SESSION does not return workout details');
  assertHttpStatus(await workoutRequest('GET', sessionPath(trainerStart.body.session.id), phase2Trainer), 404,
    'START_SESSION alone does not reveal session details', phase2FixtureState);
  assertHttpStatus(await workoutRequest('POST', `/api/v2/clients/${phase2ClientToStart.id}/workout-sessions`, phase2Trainer, {
    operationId: randomUUID(), organizationId: phase2Organization.id
  }), 404, 'START_SESSION alone cannot join or discover an existing active session', phase2FixtureState);
  assertHttpStatus(await workoutRequest('GET', sessionPath(trainerStart.body.session.id), phase2ClientToStart), 200,
    'client reads its own session', phase2FixtureState);
  const noLog = await workoutRequest('POST', `${sessionPath(trainerStart.body.session.id)}/cancel`, phase2Trainer, {
    operationId: randomUUID(), expectedSessionVersion: trainerStart.body.session.version
  });
  assertHttpStatus(noLog, 404, 'START_SESSION alone does not imply LOG_SETS', phase2FixtureState);
  assert.equal((await workoutRequest('POST', `${sessionPath(trainerStart.body.session.id)}/cancel`, phase2ClientToStart, {
    operationId: randomUUID(), expectedSessionVersion: trainerStart.body.session.version
  })).statusCode, 200);
  assert.equal(await db.clientActiveSession.count({ where: { clientUserId: phase2StartClientSql.id } }), 0, 'cancellation releases the active slot');

  const beforeCompletionResponse = await workoutRequest('GET', sessionUrl, phase2Client);
  assertHttpStatus(beforeCompletionResponse, 200, 'read session before completion race', phase2FixtureState);
  snapshot = beforeCompletionResponse.body.session;
  assert.ok(snapshot && Array.isArray(snapshot.exercises),
    `session fixture is incomplete before completion race: response=${JSON.stringify(beforeCompletionResponse.body)}; fixtures=${JSON.stringify(phase2FixtureState)}`);
  const completeOperationId = randomUUID();
  const raceExercise = snapshot.exercises.find(exercise => exercise.id === barbellRowExerciseId);
  assert.ok(raceExercise, `barbell-row fixture missing before completion race: ${JSON.stringify(sessionFixtureState(snapshot))}`);
  const raceSet = raceExercise.sets?.find(row => row.id === updatedA.id && !row.deletedAt);
  assert.ok(raceSet, `live rowA missing before completion race: ${JSON.stringify(sessionFixtureState(snapshot))}; expectedSetId=${updatedA.id}`);
  maxConcurrentWorkoutRequests = 0;
  const lifecycleRace = await Promise.all([
    workoutRequest('POST', `${sessionUrl}/complete`, phase2Client, { operationId: completeOperationId, expectedSessionVersion: snapshot.version }),
    workoutRequest('POST', `${sessionUrl}/operations`, phase2Client,
      operation('set.update', { setId: raceSet.id }, { reps: 14 }, { expectedSetVersion: raceSet.version }))
  ]);
  assert.ok(maxConcurrentWorkoutRequests >= 2, `completion and set write did not overlap: peak=${maxConcurrentWorkoutRequests}`);
  const completed = lifecycleRace[0];
  const racingUpdate = lifecycleRace[1];
  assertHttpStatus(completed, 200, 'complete session during set-write race', { fixtures: phase2FixtureState, session: sessionFixtureState(snapshot) });
  assert.ok(racingUpdate.statusCode === 200 || (racingUpdate.statusCode === 409 && racingUpdate.body.code === 'SESSION_FINALIZED'),
    `set write during completion race; response=${JSON.stringify(racingUpdate.body)}; fixtures=${JSON.stringify({ phase2FixtureState, session: sessionFixtureState(snapshot), raceSet })}`);
  const duplicateComplete = await workoutRequest('POST', `${sessionUrl}/complete`, phase2Client, {
    operationId: completeOperationId, expectedSessionVersion: snapshot.version
  });
  assert.deepEqual(duplicateComplete.body, completed.body);
  assert.equal(await db.clientActiveSession.count({ where: { clientUserId: phase2ClientSql.id } }), 0, 'completion releases the singleton active slot');
  const completedSnapshotResponse = await workoutRequest('GET', sessionUrl, phase2Client);
  assertHttpStatus(completedSnapshotResponse, 200, 'client reads completed session', phase2FixtureState);
  const completedSnapshot = completedSnapshotResponse.body.session;
  assert.equal(completedSnapshot.status, 'COMPLETED');
  assert.equal(completedSnapshot.completionSnapshot.id, sessionId);
  assert.ok(completedSnapshot.completionSnapshot.exercises.some(exercise => exercise.sets.some(set => set.done)));
  const workoutEvent = await db.workoutEvent.findFirst({ where: { sessionId } });
  const workoutOperation = await db.workoutOperation.findFirst({ where: { sessionId } });
  await assert.rejects(db.workoutEvent.update({ where: { id: workoutEvent.id }, data: { type: 'tampered' } }), /append-only|45000|WorkoutEvent/i);
  await assert.rejects(db.workoutEvent.delete({ where: { id: workoutEvent.id } }), /append-only|45000|WorkoutEvent/i);
  await assert.rejects(db.workoutOperation.update({ where: { id: workoutOperation.id }, data: { type: 'tampered' } }), /append-only|45000|WorkoutOperation/i);
  await assert.rejects(db.workoutOperation.delete({ where: { id: workoutOperation.id } }), /append-only|45000|WorkoutOperation/i);
  const nextSession = await workoutRequest('POST', `/api/v2/clients/${phase2Client.id}/workout-sessions`, phase2Client, {
    operationId: randomUUID(), organizationId: phase2Organization.id
  });
  assertHttpStatus(nextSession, 201, 'a completed client can start the next session', phase2FixtureState);
  assert.ok(nextSession.body.session?.id,
    `next session fixture has no id: response=${JSON.stringify(nextSession.body)}; fixtures=${JSON.stringify(phase2FixtureState)}`);
  assert.equal((await workoutRequest('POST', `${sessionPath(nextSession.body.session.id)}/cancel`, phase2Client, {
    operationId: randomUUID(), expectedSessionVersion: nextSession.body.session.version
  })).statusCode, 200);
  assert.equal((await request('DELETE', `/api/v2/organizations/${phase2Organization.id}/clients/me`, phase2Client)).statusCode, 200);
  assert.equal((await workoutRequest('GET', sessionUrl, phase2Client)).body.session.status, 'COMPLETED', 'the client retains workout history after leaving the gym');
  assert.equal((await workoutRequest('GET', sessionUrl, phase2Trainer)).statusCode, 404, 'leaving the gym revokes trainer access immediately');

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
  console.log('MySQL integration passed: migrations/idempotence; Phase 1 lifecycle/audit; Phase 2.5 OTP concurrency, identity uniqueness, onboarding recovery, and session-bound passkey step-up; workout authorization, concurrency, CAS, idempotency restart, replay, tombstones, and completion.');
} finally {
  await closeSaasDb();
}
