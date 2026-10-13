import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmailDelivery, emailOtpCode, emailOtpHash, emailOtpStepUpProof,
  invitationCodeHash, parseEmailOtpStepUpProof, safeHashEqual
} from '../saas/email-security.js';

test('OTP and invitation verifiers are six-digit, keyed, and bound to their challenge and recipient', () => {
  const otp = emailOtpCode();
  assert.match(otp, /^\d{6}$/);
  const otpHash = emailOtpHash('secret', 'challenge-a', otp);
  assert.equal(safeHashEqual(otpHash, emailOtpHash('secret', 'challenge-a', otp)), true);
  assert.equal(safeHashEqual(otpHash, emailOtpHash('secret', 'challenge-b', otp)), false);
  assert.notEqual(invitationCodeHash('secret', 'a@example.com', '123456'), invitationCodeHash('secret', 'b@example.com', '123456'));
});

test('passkey step-up proof rejects tampering and expiry', () => {
  const secret = 'secret';
  const values = { challengeId: 'challenge', uid: 'user', email: 'a@example.com', sv: 2, exp: Date.now() + 1000 };
  const token = emailOtpStepUpProof(secret, values);
  assert.deepEqual(parseEmailOtpStepUpProof(secret, token), values);
  assert.equal(parseEmailOtpStepUpProof(secret, token + 'x'), null);
  assert.equal(parseEmailOtpStepUpProof(secret, token, values.exp + 1), null);
});

test('email delivery stays closed without configuration and only injected test transports simulate delivery', async () => {
  for (const env of [{ NODE_ENV: 'production' }, { NODE_ENV: 'development' }]) {
    const delivery = createEmailDelivery(env);
    assert.equal(delivery.configured, false);
    await assert.rejects(delivery.send({ to: 'a@example.com', subject: 'test', text: 'test' }), { code: 'email_unconfigured' });
  }
  const fake = createEmailDelivery({}, { send: async () => ({ status: 'SIMULATED' }) });
  assert.equal(fake.configured, true);
  assert.deepEqual(await fake.send({ to: 'a@example.com', subject: 'test', text: 'test' }), { status: 'SIMULATED' });
});
