import { randomUUID, randomBytes } from 'node:crypto';
import { createWindow } from '../rate-limit.js';
import { maskEmail, normalizeEmail } from '../password.js';
import { ensureIdentity, legacyUidHash } from './identity.js';
import { acceptInvitationTx } from './routes.js';
import { invitationHash } from './invitations.js';
import { emailOtpCode, emailOtpHash, emailOtpStepUpProof, invitationCodeHash, keyedHash, safeHashEqual } from './email-security.js';
import { verificationEmail } from './email/templates.js';

const SAAS_ENABLED = /^(1|true)$/i.test(process.env.SAAS_ENABLED || '');
const OTP_ENABLED = /^(1|true|yes|on)$/i.test(process.env.SAAS_EMAIL_OTP_ENABLED || '');
const INVITES_ENABLED = /^(1|true|yes|on)$/i.test(process.env.SAAS_INVITES_V2_ENABLED || '');
const INVITE_ONLY = /^(1|true|yes|on)$/i.test(process.env.INVITE_ONLY || '');
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{40,50}$/;
const CODE = /^\d{6}$/;
const OTP_TTL_MS = 10 * 60000;
const REGISTRATION_TTL_MS = 30 * 60000;
const RESEND_MS = 60000;

class AuthError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const fail = (status, message = 'not found', code) => { throw new AuthError(status, message, code); };
const notFound = () => fail(404);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
function assertBody(body, allowed) { if (!object(body) || !onlyKeys(body, allowed)) fail(400, 'invalid request body'); }
function retry(res, seconds) {
  res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': String(seconds) });
  res.end(JSON.stringify({ error: 'too many attempts — try again later', code: 'rate_limited', retryAfter: seconds }));
}
function activeInvitation(invitation) {
  return !!invitation && !invitation.acceptedAt && !invitation.revokedAt && invitation.expiresAt > new Date() && !!invitation.targetEmail;
}
const emailLanguage = req => /^es(?:-|,|$)/i.test(String(req.headers?.['accept-language'] || '').split(';')[0].split(',')[0]) ? 'es' : 'en';

function registrationState(secret, values) {
  const payload = Buffer.from(JSON.stringify(values)).toString('base64url');
  return `${payload}.${keyedHash(secret, 'registration-state', payload)}`;
}

function parseRegistrationState(secret, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra || !safeHashEqual(signature, keyedHash(secret, 'registration-state', payload))) return null;
  try {
    const values = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return values && ID.test(values.challengeId) && typeof values.email === 'string' && typeof values.uid === 'string' && values.exp > now ? values : null;
  } catch { return null; }
}

// shortcut: these limits are process-local and reset on restart; move them to shared storage before running multiple API replicas.
function makeLimits() {
  const email = createWindow({ max: 5, windowMs: 60 * 60000 });
  const address = createWindow({ max: 20, windowMs: 60 * 60000 });
  const invite = createWindow({ max: 10, windowMs: 60 * 60000 });
  const cooldown = createWindow({ max: 1, windowMs: RESEND_MS });
  const total = createWindow({ max: 300, windowMs: 60 * 60000, maxKeys: 1 });
  const verifyAddress = createWindow({ max: 30, windowMs: 10 * 60000 });
  const verifyChallenge = createWindow({ max: 10, windowMs: 60 * 60000 });
  const invitationCode = createWindow({ max: 10, windowMs: 60 * 60000 });
  return {
    request(emailKey, addressKey, inviteKey) {
      return Math.max(total.take('all'), email.take(emailKey), address.take(addressKey), inviteKey ? invite.take(inviteKey) : 0, cooldown.take(emailKey));
    },
    verify(addressKey, challengeId) { return Math.max(verifyAddress.take(addressKey), verifyChallenge.take(challengeId)); },
    code(emailKey, addressKey) { return Math.max(invitationCode.take(`${emailKey}:${addressKey}`)); }
  };
}

export function emailAuthRoutes({
  json, readBody, readSession, getDb, secret, emailDelivery, limitAddress = req => req.socket?.remoteAddress || 'unknown',
  legacyUserById, legacyUserWithEmail, createLegacyEmailAccount, loginResponse, proveOwner, saveProof = () => {}, inviteOnly = INVITE_ONLY
}) {
  const limits = makeLimits();
  const unavailable = res => json(res, 503, { error: 'email sign-in is temporarily unavailable' });
  const route = (key, fn, requireInvites = false) => async (req, res) => {
    if (!SAAS_ENABLED || !OTP_ENABLED || (requireInvites && !INVITES_ENABLED)) return json(res, 404, { error: 'not found' });
    if (!emailDelivery?.configured) return unavailable(res);
    try { await fn(req, res, await getDb()); }
    catch (error) {
      if (error instanceof AuthError) return json(res, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
      if (error?.code === 'P2002') return json(res, 409, { error: 'email or invitation is already in use', code: 'conflict' });
      if (error?.code === 'P2025') return json(res, 404, { error: 'not found' });
      console.error('SaaS email route failed', key, error?.code || error?.name || 'unknown error');
      return unavailable(res);
    }
  };

  const invitationFor = async (db, ref, email) => {
    if (typeof ref !== 'string') return null;
    let invitation = null;
    if (TOKEN.test(ref)) invitation = await db.organizationInvitation.findUnique({ where: { tokenHash: invitationHash(ref) } });
    else if (CODE.test(ref)) invitation = await db.organizationInvitation.findUnique({ where: { invitationCodeHash: invitationCodeHash(secret, email, ref) } });
    return activeInvitation(invitation) && invitation.targetEmail === email ? invitation : null;
  };

  const invitationForCompletion = async (db, ref, email, legacyUid) => {
    if (typeof ref !== 'string') return null;
    const invitation = TOKEN.test(ref)
      ? await db.organizationInvitation.findUnique({ where: { tokenHash: invitationHash(ref) } })
      : CODE.test(ref) ? await db.organizationInvitation.findUnique({ where: { invitationCodeHash: invitationCodeHash(secret, email, ref) } }) : null;
    if (!invitation || invitation.targetEmail !== email) return null;
    if (activeInvitation(invitation)) return invitation;
    const user = await db.user.findUnique({ where: { legacyUidHash: legacyUidHash(legacyUid) } });
    return invitation.acceptedAt && invitation.acceptedByUserId === user?.id ? invitation : null;
  };

  const previewFor = async (db, invitation) => {
    const org = await db.organization.findFirst({ where: { id: invitation.organizationId, status: 'ACTIVE' }, select: { id: true, name: true, type: true } });
    if (!org) notFound();
    return {
      organization: org,
      role: invitation.type === 'CLIENT_RELATIONSHIP' ? 'CLIENT' : invitation.role,
      email: maskEmail(invitation.targetEmail),
      expiresAt: invitation.expiresAt
    };
  };

  async function sendCode(db, challenge, code, req) {
    let providerAccepted = false, providerSubmissionId = null;
    try {
      const sent = await emailDelivery.send({
        to: challenge.email,
        ...verificationEmail({ code, expiresInMinutes: OTP_TTL_MS / 60000, language: emailLanguage(req) })
      });
      if (!['ACCEPTED', 'SANDBOX', 'SIMULATED'].includes(sent?.status)) throw Object.assign(new Error('email delivery failed'), { outcome: 'unknown' });
      providerAccepted = true;
      providerSubmissionId = sent.submissionId || null;
      await db.emailOtpChallenge.update({ where: { id: challenge.id }, data: {
        deliveryStatus: sent.status,
        providerSubmissionId
      } });
    } catch (error) {
      const deliveryStatus = error?.outcome === 'unknown' || providerAccepted ? 'UNKNOWN' : 'FAILED';
      await db.emailOtpChallenge.update({ where: { id: challenge.id }, data: { deliveryStatus, providerSubmissionId } });
      console.warn(JSON.stringify({ event: 'saas.email.otp.delivery_failed', outcome: deliveryStatus.toLowerCase(), code: error?.code || 'unknown' }));
    }
  }

  async function consumeCode(db, challenge, code, purpose, now) {
    if (!challenge || challenge.purpose !== purpose || challenge.consumedAt || challenge.verifiedAt || challenge.expiresAt <= now || challenge.attempts >= 5 || !['ACCEPTED', 'SENT', 'SIMULATED'].includes(challenge.deliveryStatus)) return false;
    const supplied = emailOtpHash(secret, challenge.id, code);
    if (!safeHashEqual(challenge.codeHash, supplied)) {
      await db.emailOtpChallenge.updateMany({
        where: { id: challenge.id, purpose, consumedAt: null, verifiedAt: null, expiresAt: { gt: now }, attempts: { lt: 5 } },
        data: { attempts: { increment: 1 } }
      });
      return false;
    }
    const data = { verifiedAt: now, consumedAt: now, ...(purpose === 'SIGNUP' ? { registrationExpiresAt: new Date(now.getTime() + REGISTRATION_TTL_MS) } : {}) };
    const claimed = await db.emailOtpChallenge.updateMany({
      where: { id: challenge.id, purpose, codeHash: supplied, consumedAt: null, verifiedAt: null, expiresAt: { gt: now }, attempts: { lt: 5 }, deliveryStatus: { in: ['ACCEPTED', 'SENT', 'SIMULATED'] } },
      data
    });
    return claimed.count === 1;
  }

  async function recoverLegacyAccount(db, sqlUser) {
    if (!sqlUser?.legacyUid || !createLegacyEmailAccount) return null;
    const proof = await db.emailOtpChallenge.findFirst({
      where: { registrationUid: sqlUser.legacyUid, purpose: 'SIGNUP', completedAt: { not: null } },
      orderBy: { completedAt: 'desc' }
    });
    if (!proof) return null;
    return createLegacyEmailAccount({ id: sqlUser.legacyUid, name: sqlUser.displayName, challengeId: proof.id, preferences: proof.profilePreferences || {} });
  }

  return {
    'POST /api/v2/auth/email/request': route('request', async (req, res, db) => {
      const body = await readBody(req);
      assertBody(body, ['email', 'purpose', 'invitationRef']);
      const email = normalizeEmail(body.email);
      if (!email) fail(400, 'email is invalid', 'email-invalid');
      if (!['LOGIN', 'INVITATION'].includes(body.purpose)) fail(400, 'purpose must be LOGIN or INVITATION');
      if (body.invitationRef !== undefined && (typeof body.invitationRef !== 'string' || body.invitationRef.length > 64)) fail(400, 'invitationRef is invalid');
      if ((body.purpose === 'INVITATION' || body.invitationRef) && !INVITES_ENABLED) notFound();

      const address = String(limitAddress(req) || 'unknown').slice(0, 80);
      const wait = limits.request(keyedHash(secret, 'rate-email', email), keyedHash(secret, 'rate-address', address), body.invitationRef ? keyedHash(secret, 'rate-invite', body.invitationRef) : null);
      if (wait) return retry(res, wait);
      const invitation = body.invitationRef ? await invitationFor(db, body.invitationRef, email) : null;
      const emailIdentity = await db.verifiedEmailIdentity.findUnique({ where: { email }, include: { user: true } });
      const maySend = body.purpose === 'LOGIN'
        ? !!emailIdentity && (!body.invitationRef || !!invitation)
        : !!invitation || (!inviteOnly && !body.invitationRef);

      const purpose = emailIdentity ? 'LOGIN' : 'SIGNUP';
      let registrationUid = null;
      if (maySend && purpose === 'SIGNUP') {
        do { registrationUid = randomBytes(12).toString('base64url'); } while (legacyUserById(registrationUid));
      }
      const id = randomUUID(), code = emailOtpCode(), now = new Date();
      const challenge = await db.$transaction(async tx => {
        if (maySend) await tx.emailOtpChallenge.updateMany({ where: { email, purpose, consumedAt: null, verifiedAt: null }, data: { consumedAt: now } });
        return tx.emailOtpChallenge.create({ data: {
          id, email, purpose, codeHash: maySend ? emailOtpHash(secret, id, code) : keyedHash(secret, 'decoy', id),
          invitationId: invitation?.id || null, registrationUid,
          attempts: 0, expiresAt: new Date(now.getTime() + OTP_TTL_MS), deliveryStatus: maySend ? 'PENDING' : 'SUPPRESSED'
        } });
      });
      if (maySend) await sendCode(db, challenge, code, req);
      json(res, 202, { accepted: true, challengeId: id, resendAfter: RESEND_MS / 1000 });
    }),

    'POST /api/v2/auth/email/verify': route('verify', async (req, res, db) => {
      const body = await readBody(req);
      assertBody(body, ['challengeId', 'code']);
      if (typeof body.challengeId !== 'string' || !ID.test(body.challengeId) || typeof body.code !== 'string' || !CODE.test(body.code)) fail(400, 'code is invalid or expired', 'code-invalid');
      const address = String(limitAddress(req) || 'unknown').slice(0, 80);
      const wait = limits.verify(keyedHash(secret, 'rate-address', address), body.challengeId);
      if (wait) return retry(res, wait);
      const challenge = await db.emailOtpChallenge.findUnique({ where: { id: body.challengeId } });
      const now = new Date();
      if (!['LOGIN', 'SIGNUP'].includes(challenge?.purpose) || !await consumeCode(db, challenge, body.code, challenge.purpose, now)) {
        return json(res, 400, { error: 'code is invalid or expired', code: 'code-invalid' });
      }
      const verifiedChallenge = await db.emailOtpChallenge.findUnique({ where: { id: challenge.id } });

      const emailIdentity = await db.verifiedEmailIdentity.findUnique({ where: { email: challenge.email }, include: { user: true } });
      if (emailIdentity) {
        let user = legacyUserById(emailIdentity.user?.legacyUid);
        if (user?.emailOtpChallengeId) {
          const signup = await db.emailOtpChallenge.findUnique({ where: { id: user.emailOtpChallengeId } });
          if (signup) user = await createLegacyEmailAccount({ id: user.id, name: user.name, challengeId: signup.id, preferences: signup.profilePreferences || {} });
        }
        const recovered = user || await recoverLegacyAccount(db, emailIdentity.user);
        if (!recovered || recovered.disabled || emailIdentity.user?.status === 'DELETED') return json(res, 403, { error: 'account is unavailable', code: 'account-unavailable' });
        const preview = challenge.invitationId ? await db.organizationInvitation.findUnique({ where: { id: challenge.invitationId } }).then(inv => activeInvitation(inv) && inv.targetEmail === challenge.email ? previewFor(db, inv) : null) : null;
        return loginResponse(req, res, recovered, { ...(preview ? { invitation: preview } : {}) });
      }

      if (legacyUserWithEmail?.(challenge.email)) return json(res, 409, { error: 'sign in with your passkey, then verify this email in Settings', code: 'email-link-required' });
      if (inviteOnly && !challenge.invitationId) return json(res, 403, { error: 'a valid invitation is required', code: 'invitation-required' });
      const invitation = challenge.invitationId ? await db.organizationInvitation.findUnique({ where: { id: challenge.invitationId } }) : null;
      if (challenge.invitationId && (!activeInvitation(invitation) || invitation.targetEmail !== challenge.email)) return json(res, 404, { error: 'invitation is no longer available', code: 'invitation-unavailable' });
      const registration = registrationState(secret, {
        challengeId: verifiedChallenge.id, email: verifiedChallenge.email, uid: verifiedChallenge.registrationUid,
        exp: verifiedChallenge.registrationExpiresAt.getTime()
      });
      json(res, 200, {
        status: 'registration_required', registrationState: registration,
        email: maskEmail(verifiedChallenge.email), ...(invitation ? { invitation: await previewFor(db, invitation) } : {})
      });
    }),

    'POST /api/v2/invitations/preview': route('preview', async (req, res, db) => {
      const body = await readBody(req);
      assertBody(body, ['token', 'code', 'registrationState']);
      if ((body.token == null) === (body.code == null)) fail(400, 'provide exactly one invitation token or code');
      let email = null, invitation = null;
      if (body.token != null) {
        if (typeof body.token !== 'string' || !TOKEN.test(body.token)) notFound();
        invitation = await db.organizationInvitation.findUnique({ where: { tokenHash: invitationHash(body.token) } });
        if (!activeInvitation(invitation)) notFound();
        email = invitation.targetEmail;
      } else {
        if (typeof body.code !== 'string' || !CODE.test(body.code)) notFound();
        const proof = parseRegistrationState(secret, body.registrationState);
        if (proof) email = proof.email;
        else {
          const sessionUser = readSession(req);
          if (sessionUser) {
            const actor = await ensureIdentity(db, sessionUser);
            email = (await db.verifiedEmailIdentity.findUnique({ where: { userId: actor.id } }))?.email || null;
          }
        }
        if (!email) notFound();
        const address = String(limitAddress(req) || 'unknown').slice(0, 80);
        const wait = limits.code(keyedHash(secret, 'rate-email', email), keyedHash(secret, 'rate-address', address));
        if (wait) return retry(res, wait);
        invitation = await invitationFor(db, body.code, email);
        if (!invitation) notFound();
      }
      if (body.token == null && body.registrationState) {
        const proof = parseRegistrationState(secret, body.registrationState);
        const challenge = proof && await db.emailOtpChallenge.findUnique({ where: { id: proof.challengeId } });
        if (!proof || !challenge || challenge.email !== email || !challenge.verifiedAt || challenge.registrationUid !== proof.uid || challenge.registrationExpiresAt <= new Date()) notFound();
      }
      json(res, 200, { invitation: await previewFor(db, invitation) });
    }, true),

    'POST /api/v2/onboarding/complete': route('complete', async (req, res, db) => {
      const body = await readBody(req);
      assertBody(body, ['registrationState', 'invitationRef', 'name', 'phone', 'preferences']);
      const proof = parseRegistrationState(secret, body.registrationState);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!proof || !name || name.length > 40) fail(400, 'verified email and a name are required');
      if (body.phone != null && (typeof body.phone !== 'string' || !/^\+[1-9]\d{7,14}$/.test(body.phone))) fail(400, 'phone must use E.164 format');
      const preferences = body.preferences === undefined ? { unit: 'kg', lang: 'en' } : body.preferences;
      if (!object(preferences) || !onlyKeys(preferences, ['unit', 'lang']) || !['kg', 'lb'].includes(preferences.unit) || typeof preferences.lang !== 'string' || !/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?$/.test(preferences.lang)) fail(400, 'preferences are invalid');
      const challenge = await db.emailOtpChallenge.findUnique({ where: { id: proof.challengeId } });
      if (!challenge || challenge.purpose !== 'SIGNUP' || challenge.email !== proof.email || challenge.registrationUid !== proof.uid || !challenge.verifiedAt || !challenge.consumedAt || (!challenge.completedAt && challenge.registrationExpiresAt <= new Date())) notFound();
      const invitation = body.invitationRef == null ? null : await invitationForCompletion(db, body.invitationRef, proof.email, proof.uid);
      if (challenge.invitationId && (!invitation || invitation.id !== challenge.invitationId)) notFound();
      if (body.invitationRef != null && (!invitation || invitation.id !== challenge.invitationId)) notFound();
      if (inviteOnly && !invitation) fail(403, 'a valid invitation is required', 'invitation-required');

      const result = await db.$transaction(async tx => {
        const current = await tx.emailOtpChallenge.findUnique({ where: { id: challenge.id } });
        if (current.completedAt) {
          if (current.registrationUid !== proof.uid) notFound();
          const userIdentity = await tx.verifiedEmailIdentity.findUnique({ where: { email: proof.email }, include: { user: true } });
          if (!userIdentity || userIdentity.user.legacyUid !== proof.uid) notFound();
          const accepted = invitation ? await acceptInvitationTx(tx, invitation.id, userIdentity.user, { id: proof.uid }) : null;
          return { actor: userIdentity.user, accepted };
        }

        const actor = await ensureIdentity(tx, { id: proof.uid, name });
        if (!actor || actor.status !== 'ACTIVE') notFound();
        const currentEmail = await tx.verifiedEmailIdentity.findUnique({ where: { email: proof.email } });
        if (currentEmail && currentEmail.userId !== actor.id) fail(409, 'email is already linked to another account', 'email-in-use');
        if (!currentEmail) await tx.verifiedEmailIdentity.create({ data: { userId: actor.id, email: proof.email, verifiedAt: challenge.verifiedAt, source: 'SIGNUP' } });
        await tx.user.update({ where: { id: actor.id }, data: { phone: body.phone || null, onboardingCompletedAt: new Date() } });
        const accepted = invitation ? await acceptInvitationTx(tx, invitation.id, actor, { id: proof.uid, name }) : null;
        const completed = await tx.emailOtpChallenge.updateMany({
          where: { id: challenge.id, completedAt: null, registrationUid: proof.uid },
          data: { completedAt: new Date(), profilePreferences: preferences }
        });
        if (completed.count !== 1) fail(409, 'onboarding is already being completed', 'onboarding-race');
        return { actor, accepted };
      });
      const completedChallenge = await db.emailOtpChallenge.findUnique({ where: { id: challenge.id } });
      let legacyUser = legacyUserById(proof.uid);
      if (!legacyUser || legacyUser.emailOtpChallengeId === challenge.id) {
        legacyUser = await createLegacyEmailAccount({ id: proof.uid, name: result.actor.displayName || name, challengeId: challenge.id, preferences: completedChallenge?.profilePreferences || preferences });
      }
      if (!legacyUser || legacyUser.disabled) fail(503, 'account could not be prepared');
      return loginResponse(req, res, legacyUser, { onboarded: true, ...(result.accepted ? { accepted: result.accepted } : {}) });
    }, true),

    'GET /api/v2/auth/email/status': route('status', async (req, res, db) => {
      const legacyUser = readSession(req);
      if (!legacyUser) return json(res, 401, { error: 'not signed in' });
      const actor = await ensureIdentity(db, legacyUser);
      if (!actor || actor.status !== 'ACTIVE') return json(res, 403, { error: 'forbidden' });
      const identity = await db.verifiedEmailIdentity.findUnique({ where: { userId: actor.id } });
      json(res, 200, { email: identity ? maskEmail(identity.email) : null, verifiedAt: identity?.verifiedAt || null });
    }),

    'POST /api/v2/auth/email/reauth/request': route('reauth-request', async (req, res, db) => {
      const legacyUser = readSession(req);
      if (!legacyUser) return json(res, 401, { error: 'not signed in' });
      const sessionVersion = legacyUser.sv || 0;
      assertBody(await readBody(req), []);
      const actor = await ensureIdentity(db, legacyUser);
      if (!actor || actor.status !== 'ACTIVE') return json(res, 403, { error: 'forbidden' });
      const identity = await db.verifiedEmailIdentity.findUnique({ where: { userId: actor.id } });
      if (!identity) fail(409, 'link a verified e-mail before adding a passkey', 'verified-email-required');
      const address = String(limitAddress(req) || 'unknown').slice(0, 80);
      const wait = limits.request(keyedHash(secret, 'rate-email', identity.email), keyedHash(secret, 'rate-address', address), null);
      if (wait) return retry(res, wait);
      if (readSession(req) !== legacyUser || (legacyUser.sv || 0) !== sessionVersion) return json(res, 401, { error: 'not signed in' });
      const id = randomUUID(), code = emailOtpCode(), now = new Date();
      const challenge = await db.$transaction(async tx => {
        await tx.emailOtpChallenge.updateMany({ where: { email: identity.email, purpose: 'PASSKEY_ADD', consumedAt: null, verifiedAt: null }, data: { consumedAt: now } });
        return tx.emailOtpChallenge.create({ data: {
          id, email: identity.email, purpose: 'PASSKEY_ADD', codeHash: emailOtpHash(secret, id, code), legacyUid: legacyUser.id,
          sessionVersion,
          expiresAt: new Date(now.getTime() + OTP_TTL_MS), deliveryStatus: 'PENDING'
        } });
      });
      await sendCode(db, challenge, code, req);
      json(res, 202, { accepted: true, challengeId: id, resendAfter: RESEND_MS / 1000, email: maskEmail(identity.email) });
    }),

    'POST /api/v2/auth/email/reauth/verify': route('reauth-verify', async (req, res, db) => {
      const legacyUser = readSession(req);
      if (!legacyUser) return json(res, 401, { error: 'not signed in' });
      const sessionVersion = legacyUser.sv || 0;
      const body = await readBody(req);
      assertBody(body, ['challengeId', 'code']);
      if (typeof body.challengeId !== 'string' || !ID.test(body.challengeId) || typeof body.code !== 'string' || !CODE.test(body.code)) fail(400, 'code is invalid or expired', 'code-invalid');
      const address = String(limitAddress(req) || 'unknown').slice(0, 80);
      const wait = limits.verify(keyedHash(secret, 'rate-address', address), body.challengeId);
      if (wait) return retry(res, wait);
      const actor = await ensureIdentity(db, legacyUser);
      if (!actor || actor.status !== 'ACTIVE') return json(res, 403, { error: 'forbidden' });
      const challenge = await db.emailOtpChallenge.findUnique({ where: { id: body.challengeId } });
      const now = new Date();
      if (challenge?.legacyUid !== legacyUser.id || challenge.sessionVersion !== sessionVersion) return json(res, 400, { error: 'code is invalid or expired', code: 'code-invalid' });
      if (readSession(req) !== legacyUser || (legacyUser.sv || 0) !== sessionVersion) return json(res, 401, { error: 'not signed in' });
      if (!await consumeCode(db, challenge, body.code, 'PASSKEY_ADD', now)) return json(res, 400, { error: 'code is invalid or expired', code: 'code-invalid' });
      if (readSession(req) !== legacyUser || (legacyUser.sv || 0) !== sessionVersion) return json(res, 401, { error: 'not signed in' });
      const identity = await db.verifiedEmailIdentity.findUnique({ where: { userId: actor.id } });
      if (!identity || identity.email !== challenge.email) notFound();
      const proof = emailOtpStepUpProof(secret, {
        challengeId: challenge.id, uid: legacyUser.id, email: identity.email,
        sv: sessionVersion,
        exp: Math.min(challenge.expiresAt.getTime(), Date.now() + 5 * 60000)
      });
      json(res, 200, { proof, expiresAt: new Date(Math.min(challenge.expiresAt.getTime(), Date.now() + 5 * 60000)) });
    }),

    'POST /api/v2/auth/email/link/request': route('link-request', async (req, res, db) => {
      const legacyUser = readSession(req);
      if (!legacyUser) return json(res, 401, { error: 'not signed in' });
      const sessionVersion = legacyUser.sv || 0;
      const body = await readBody(req);
      assertBody(body, ['email', 'current', 'cid', 'credential']);
      const email = normalizeEmail(body.email);
      if (!email) fail(400, 'email is invalid', 'email-invalid');
      const proof = await proveOwner(req, res, legacyUser, body, 'email-link');
      if (!proof) return;
      if (readSession(req) !== legacyUser || (legacyUser.sv || 0) !== sessionVersion) return json(res, 401, { error: 'not signed in' });
      saveProof(proof);
      const actor = await ensureIdentity(db, legacyUser);
      if (!actor || actor.status !== 'ACTIVE') return json(res, 403, { error: 'forbidden' });
      const existing = await db.verifiedEmailIdentity.findUnique({ where: { email } });
      if (existing) {
        if (existing.userId !== actor.id) fail(409, 'email is already linked to another account', 'email-in-use');
        return json(res, 200, { alreadyVerified: true, email: maskEmail(email) });
      }
      const address = String(limitAddress(req) || 'unknown').slice(0, 80);
      const wait = limits.request(keyedHash(secret, 'rate-email', email), keyedHash(secret, 'rate-address', address), null);
      if (wait) return retry(res, wait);
      if (readSession(req) !== legacyUser || (legacyUser.sv || 0) !== sessionVersion) return json(res, 401, { error: 'not signed in' });
      const id = randomUUID(), code = emailOtpCode(), now = new Date();
      const challenge = await db.$transaction(async tx => {
        await tx.emailOtpChallenge.updateMany({ where: { email, purpose: 'LINK_EMAIL', consumedAt: null, verifiedAt: null }, data: { consumedAt: now } });
        return tx.emailOtpChallenge.create({ data: {
          id, email, purpose: 'LINK_EMAIL', codeHash: emailOtpHash(secret, id, code), legacyUid: legacyUser.id,
          sessionVersion,
          expiresAt: new Date(now.getTime() + OTP_TTL_MS), deliveryStatus: 'PENDING'
        } });
      });
      await sendCode(db, challenge, code, req);
      json(res, 202, { accepted: true, challengeId: id, resendAfter: RESEND_MS / 1000 });
    }),

    'POST /api/v2/auth/email/link/verify': route('link-verify', async (req, res, db) => {
      const legacyUser = readSession(req);
      if (!legacyUser) return json(res, 401, { error: 'not signed in' });
      const sessionVersion = legacyUser.sv || 0;
      const body = await readBody(req);
      assertBody(body, ['challengeId', 'code']);
      if (typeof body.challengeId !== 'string' || !ID.test(body.challengeId) || typeof body.code !== 'string' || !CODE.test(body.code)) fail(400, 'code is invalid or expired', 'code-invalid');
      const actor = await ensureIdentity(db, legacyUser);
      if (!actor || actor.status !== 'ACTIVE') return json(res, 403, { error: 'forbidden' });
      const challenge = await db.emailOtpChallenge.findUnique({ where: { id: body.challengeId } });
      const now = new Date();
      if (challenge?.legacyUid !== legacyUser.id || challenge.sessionVersion !== sessionVersion) return json(res, 400, { error: 'code is invalid or expired', code: 'code-invalid' });
      if (readSession(req) !== legacyUser || (legacyUser.sv || 0) !== sessionVersion) return json(res, 401, { error: 'not signed in' });
      if (!await consumeCode(db, challenge, body.code, 'LINK_EMAIL', now)) return json(res, 400, { error: 'code is invalid or expired', code: 'code-invalid' });
      if (readSession(req) !== legacyUser || (legacyUser.sv || 0) !== sessionVersion) return json(res, 401, { error: 'not signed in' });
      const verified = await db.emailOtpChallenge.findUnique({ where: { id: challenge.id } });
      if (readSession(req) !== legacyUser || (legacyUser.sv || 0) !== sessionVersion) return json(res, 401, { error: 'not signed in' });
      const existing = await db.verifiedEmailIdentity.findUnique({ where: { email: verified.email } });
      if (existing && existing.userId !== actor.id) fail(409, 'email is already linked to another account', 'email-in-use');
      if (!existing) await db.verifiedEmailIdentity.create({ data: { userId: actor.id, email: verified.email, verifiedAt: verified.verifiedAt, source: 'LINK_EMAIL' } });
      json(res, 200, { email: maskEmail(verified.email), verifiedAt: verified.verifiedAt });
    })
  };
}
