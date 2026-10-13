import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
export { createEmailDelivery } from './email/provider.js';

export const emailOtpCode = () => String(randomInt(0, 1000000)).padStart(6, '0');

export function keyedHash(secret, purpose, value) {
  return createHmac('sha256', secret).update(`${purpose}:${value}`).digest('hex');
}

export const emailOtpHash = (secret, challengeId, code) => keyedHash(secret, 'email-otp', `${challengeId}:${code}`);
export const invitationCodeHash = (secret, email, code) => keyedHash(secret, 'invitation-code', `${email}:${code}`);

export function emailOtpStepUpProof(secret, values) {
  const payload = Buffer.from(JSON.stringify(values)).toString('base64url');
  return `${payload}.${keyedHash(secret, 'email-otp-step-up', payload)}`;
}

export function parseEmailOtpStepUpProof(secret, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra || !safeHashEqual(signature, keyedHash(secret, 'email-otp-step-up', payload))) return null;
  try {
    const values = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return values && typeof values.challengeId === 'string' && typeof values.uid === 'string' && typeof values.email === 'string' && values.exp > now ? values : null;
  } catch { return null; }
}

export function safeHashEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
