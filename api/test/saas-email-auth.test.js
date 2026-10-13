import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emailOtpHash } from '../saas/email-security.js';

process.env.SAAS_ENABLED = '1';
process.env.SAAS_EMAIL_OTP_ENABLED = '1';
const { emailAuthRoutes } = await import('../saas/email-auth-routes.js');

const id = '550e8400-e29b-41d4-a716-446655440000';
const secret = 'route-test-secret';
const response = () => ({
  status: 0, body: null, headers: {},
  writeHead(status, headers) { this.status = status; this.headers = headers; },
  end(body) { this.body = JSON.parse(body); }
});
const json = (_res, status, body) => { _res.status = status; _res.body = body; };
const makeChallenge = (purpose, email, sessionVersion = null) => ({
  id, email, purpose, sessionVersion, codeHash: emailOtpHash(secret, id, '123456'),
  attempts: 0, expiresAt: new Date(Date.now() + 60000), deliveryStatus: 'SIMULATED',
  consumedAt: null, verifiedAt: null
});
const routes = ({ db, readSession = () => null, legacyUserWithEmail = () => null, legacyUserById = () => null, loginResponse = () => assert.fail('must not sign in'), emailDelivery = { configured: true, send: async () => ({ status: 'SIMULATED' }) }, getDb = async () => db }) => emailAuthRoutes({
  json, readBody: async req => req.body, readSession, getDb, secret, emailDelivery,
  limitAddress: () => '127.0.0.1', legacyUserById, legacyUserWithEmail,
  createLegacyEmailAccount: async () => null, loginResponse, proveOwner: async () => 'password'
});

function requestDatabase() {
  const challenges = new Map();
  const db = {
    $transaction: fn => fn(db),
    verifiedEmailIdentity: { findUnique: async ({ where }) => where.email === 'known@example.com' ? { email: where.email, user: { legacyUid: 'known-user' } } : null },
    emailOtpChallenge: {
      create: async ({ data }) => { const row = { ...data, consumedAt: null, verifiedAt: null }; challenges.set(row.id, row); return row; },
      findUnique: async ({ where }) => challenges.get(where.id) || null,
      update: async ({ where, data }) => { const row = challenges.get(where.id); Object.assign(row, data); return row; },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of challenges.values()) {
          if (where.id && row.id !== where.id) continue;
          if (where.email && row.email !== where.email) continue;
          if (where.purpose && row.purpose !== where.purpose) continue;
          if (where.consumedAt === null && row.consumedAt !== null) continue;
          if (where.verifiedAt === null && row.verifiedAt !== null) continue;
          if (where.completedAt === null && row.completedAt !== null) continue;
          if (where.attempts?.lt != null && row.attempts >= where.attempts.lt) continue;
          if (where.deliveryStatus?.in && !where.deliveryStatus.in.includes(row.deliveryStatus)) continue;
          if (data.attempts?.increment) row.attempts += data.attempts.increment;
          else Object.assign(row, data);
          count++;
        }
        return { count };
      }
    }
  };
  return { db, challenges };
}

test('email OTP cannot authenticate an existing account through its unverified legacy e-mail field', async () => {
  const challenge = makeChallenge('LOGIN', 'old@example.com');
  const db = {
    emailOtpChallenge: {
      findUnique: async () => challenge,
      updateMany: async ({ data }) => { Object.assign(challenge, data); return { count: 1 }; }
    },
    verifiedEmailIdentity: { findUnique: async () => null }
  };
  const handler = routes({ db, legacyUserWithEmail: () => ({ id: 'legacy-user', email: 'old@example.com' }) })['POST /api/v2/auth/email/verify'];
  const res = response();

  await handler({ body: { challengeId: id, code: '123456' } }, res);

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'email-link-required');
});

test('e-mail link challenges from a different session version are not consumed', async () => {
  const user = { id: 'legacy-user', name: 'Ada', sv: 2 };
  const actor = { id: 'sql-user', legacyUid: user.id, displayName: user.name, status: 'ACTIVE' };
  const challenge = makeChallenge('LINK_EMAIL', 'new@example.com', 1);
  let consumed = false;
  const db = {
    user: { findUnique: async () => actor },
    emailOtpChallenge: {
      findUnique: async () => challenge,
      updateMany: async () => { consumed = true; return { count: 1 }; }
    },
    verifiedEmailIdentity: { findUnique: async () => null }
  };
  const handler = routes({ db, readSession: () => user })['POST /api/v2/auth/email/link/verify'];
  const res = response();

  await handler({ body: { challengeId: id, code: '123456' } }, res);

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'code-invalid');
  assert.equal(consumed, false);
});

test('eligible OTP requests use a bilingual HTML and text mail and record provider acceptance', async () => {
  const { db, challenges } = requestDatabase();
  let mail;
  const handler = routes({ db, emailDelivery: { configured: true, send: async value => { mail = value; return { status: 'ACCEPTED', submissionId: 'brevo-message-1' }; } } })['POST /api/v2/auth/email/request'];
  const res = response();

  await handler({ headers: { 'accept-language': 'es-BO,es;q=0.9' }, body: { email: 'known@example.com', purpose: 'LOGIN' } }, res);

  assert.equal(res.status, 202);
  assert.equal(res.body.accepted, true);
  assert.match(mail.subject, /verificación/);
  assert.match(mail.text, /vence en 10 minutos/);
  assert.match(mail.html, /lang="es"/);
  const stored = challenges.get(res.body.challengeId);
  assert.equal(stored.deliveryStatus, 'ACCEPTED');
  assert.equal(stored.providerSubmissionId, 'brevo-message-1');
  assert.equal(Object.hasOwn(stored, 'code'), false);
});

test('definite provider rejection preserves a generic response and leaves the code unusable', async () => {
  const { db, challenges } = requestDatabase();
  const error = Object.assign(new Error('provider rejected'), { code: 'email_provider_rejected', outcome: 'rejected' });
  const handler = routes({ db, emailDelivery: { configured: true, send: async () => { throw error; } } })['POST /api/v2/auth/email/request'];
  const res = response();

  await handler({ body: { email: 'known@example.com', purpose: 'LOGIN' } }, res);

  assert.equal(res.status, 202);
  const stored = challenges.get(res.body.challengeId);
  assert.equal(stored.deliveryStatus, 'FAILED');
});

test('ambiguous provider outcomes are recorded as unknown and cannot redeem the OTP', async () => {
  const { db, challenges } = requestDatabase();
  let code;
  const deliveryError = Object.assign(new Error('timed out'), { code: 'email_provider_timeout', outcome: 'unknown' });
  const handler = routes({ db, emailDelivery: { configured: true, send: async mail => {
    code = mail.text.match(/\n\n(\d{6})\n\n/)?.[1];
    throw deliveryError;
  } } });
  const request = response();
  await handler['POST /api/v2/auth/email/request']({ body: { email: 'known@example.com', purpose: 'LOGIN' } }, request);
  const stored = challenges.get(request.body.challengeId);
  assert.equal(stored.deliveryStatus, 'UNKNOWN');
  assert.match(code, /^\d{6}$/);

  const verify = response();
  await handler['POST /api/v2/auth/email/verify']({ body: { challengeId: stored.id, code } }, verify);
  assert.equal(verify.status, 400);
  assert.equal(verify.body.code, 'code-invalid');
});

test('accepted provider submissions stay unknown and unusable if recording acceptance fails', async () => {
  const { db, challenges } = requestDatabase();
  let code;
  db.emailOtpChallenge.update = async ({ where, data }) => {
    if (data.deliveryStatus === 'ACCEPTED') throw new Error('temporary database failure');
    Object.assign(challenges.get(where.id), data);
  };
  const handler = routes({ db, emailDelivery: { configured: true, send: async mail => {
    code = mail.text.match(/\b(\d{6})\b/)?.[1];
    return { status: 'ACCEPTED', submissionId: 'brevo-message-after-db-error' };
  } } });
  const request = response();
  await handler['POST /api/v2/auth/email/request']({ body: { email: 'known@example.com', purpose: 'LOGIN' } }, request);
  assert.equal(request.status, 202);
  const stored = challenges.get(request.body.challengeId);
  assert.equal(stored.deliveryStatus, 'UNKNOWN');
  assert.equal(stored.providerSubmissionId, 'brevo-message-after-db-error');

  const verify = response();
  await handler['POST /api/v2/auth/email/verify']({ body: { challengeId: stored.id, code } }, verify);
  assert.equal(verify.status, 400);
});

test('unconfigured OTP provider fails closed before creating a challenge', async () => {
  let dbLookups = 0;
  const handler = routes({ getDb: async () => { dbLookups++; return {}; }, emailDelivery: { configured: false } })['POST /api/v2/auth/email/request'];
  const res = response();
  await handler({ body: { email: 'known@example.com', purpose: 'LOGIN' } }, res);
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { error: 'email sign-in is temporarily unavailable' });
  assert.equal(dbLookups, 0);
});

test('OTP verification counts wrong attempts and atomically accepts a code only once under concurrency', async () => {
  const { db, challenges } = requestDatabase();
  const challenge = makeChallenge('LOGIN', 'known@example.com');
  challenges.set(challenge.id, challenge);
  const user = { id: 'known-user', name: 'Ada' };
  let logins = 0;
  const handler = routes({
    db, legacyUserById: id => id === user.id ? user : null,
    loginResponse: (_req, res, signedInUser) => { logins++; json(res, 200, { user: signedInUser }); }
  })['POST /api/v2/auth/email/verify'];

  const wrong = response();
  await handler({ body: { challengeId: id, code: '111111' } }, wrong);
  assert.equal(wrong.status, 400);
  assert.equal(challenge.attempts, 1);

  const results = await Promise.all([1, 2].map(async () => {
    const res = response();
    await handler({ body: { challengeId: id, code: '123456' } }, res);
    return res;
  }));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
  assert.equal(logins, 1);
  assert.ok(challenge.consumedAt);

  const replay = response();
  await handler({ body: { challengeId: id, code: '123456' } }, replay);
  assert.equal(replay.status, 400);
  assert.equal(logins, 1);
});

test('expired OTPs and resend requests inside the cooldown are refused', async () => {
  const { db, challenges } = requestDatabase();
  const challenge = makeChallenge('LOGIN', 'known@example.com');
  challenge.expiresAt = new Date(Date.now() - 1);
  challenges.set(challenge.id, challenge);
  const verify = routes({ db })['POST /api/v2/auth/email/verify'];
  const expired = response();
  await verify({ body: { challengeId: id, code: '123456' } }, expired);
  assert.equal(expired.status, 400);

  const request = routes({ db })['POST /api/v2/auth/email/request'];
  const first = response();
  await request({ body: { email: 'known@example.com', purpose: 'LOGIN' } }, first);
  assert.equal(first.status, 202);
  const resend = response();
  await request({ body: { email: 'known@example.com', purpose: 'LOGIN' } }, resend);
  assert.equal(resend.status, 429);
  assert.equal(resend.headers['Retry-After'], '60');
});

test('five incorrect OTP guesses lock that challenge even when the correct code is supplied next', async () => {
  const { db, challenges } = requestDatabase();
  const challenge = makeChallenge('LOGIN', 'known@example.com');
  challenge.attempts = 4;
  challenges.set(challenge.id, challenge);
  const handler = routes({ db })['POST /api/v2/auth/email/verify'];

  const fifthWrong = response();
  await handler({ body: { challengeId: id, code: '111111' } }, fifthWrong);
  assert.equal(fifthWrong.status, 400);
  assert.equal(challenge.attempts, 5);

  const afterLimit = response();
  await handler({ body: { challengeId: id, code: '123456' } }, afterLimit);
  assert.equal(afterLimit.status, 400);
  assert.equal(challenge.consumedAt, null);
});
