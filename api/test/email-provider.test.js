import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmailDelivery, createEmailProvider } from '../saas/email/provider.js';
import { verificationEmail } from '../saas/email/templates.js';

const env = overrides => ({
  EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'private-api-key-for-test',
  BREVO_SENDER_EMAIL: 'auth@example.com', BREVO_SENDER_NAME: 'OpenGym',
  BREVO_TIMEOUT_MS: '10000', BREVO_SANDBOX: '0', ...overrides
});
const email = verificationEmail({ code: '012345', expiresInMinutes: 10, language: 'en' });
const response = (status, body = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('Brevo sends one authenticated JSON request with both OTP formats and records its submission id', async () => {
  const calls = [], logs = [];
  const provider = createEmailProvider(env(), {
    logger: { info: value => logs.push(value), warn: value => logs.push(value), error: value => logs.push(value) },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response(201, { messageId: '<message-1@example.com>' }); }
  });
  assert.equal(provider.configured, true);
  assert.deepEqual(await provider.send({ to: 'person@example.com', ...email }), { status: 'ACCEPTED', submissionId: '<message-1@example.com>' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers['api-key'], 'private-api-key-for-test');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    sender: { name: 'OpenGym', email: 'auth@example.com' },
    to: [{ email: 'person@example.com' }], subject: email.subject,
    htmlContent: email.html, textContent: email.text
  });
  const logsText = logs.join('\n');
  assert.doesNotMatch(logsText, /private-api-key-for-test|person@example\.com|012345/);
  assert.match(logsText, /message-1@example\.com/);
});

test('Brevo sandbox uses the documented payload header and is not reported as a delivered email', async () => {
  let payload;
  const provider = createEmailProvider(env({ BREVO_SANDBOX: '1' }), {
    logger: {}, fetchImpl: async (_url, options) => { payload = JSON.parse(options.body); return response(201, { messageId: 'sandbox-1' }); }
  });
  assert.equal(provider.configured, true);
  assert.equal(provider.sandbox, true);
  assert.deepEqual(await provider.send({ to: 'person@example.com', ...email }), { status: 'SANDBOX', submissionId: 'sandbox-1' });
  assert.deepEqual(payload.headers, { 'X-Sib-Sandbox': 'drop' });
});

test('missing or invalid configuration fails closed without making a request', async () => {
  for (const config of [
    {}, env({ BREVO_API_KEY: '' }), env({ BREVO_API_KEY: 'key\r\nX: y' }),
    env({ BREVO_SENDER_EMAIL: 'bad sender' }), env({ BREVO_TIMEOUT_MS: '0' }),
    env({ BREVO_TIMEOUT_MS: '70000' }), env({ BREVO_SANDBOX: 'true' }),
    { ...env(), EMAIL_PROVIDER: 'smtp' }
  ]) {
    const delivery = createEmailDelivery(config, null, { fetchImpl: async () => assert.fail('unconfigured provider made a request') });
    assert.equal(delivery.configured, false);
    await assert.rejects(delivery.send({ to: 'person@example.com', ...email }), { code: 'email_unconfigured' });
  }
});

test('invalid mail input is rejected before fetch', async () => {
  let calls = 0;
  const provider = createEmailProvider(env(), { fetchImpl: async () => { calls++; return response(201); }, logger: {} });
  for (const mail of [
    { to: 'bad address', subject: 'test', text: 'test' },
    { to: 'person@example.com', subject: 'line\nbreak', text: 'test' },
    { to: 'person@example.com', subject: 'test' },
    null
  ]) await assert.rejects(provider.send(mail), { code: 'email_invalid' });
  assert.equal(calls, 0);
});

test('Brevo rejects client errors, treats 5xx as uncertain, and never retries the POST', async t => {
  for (const status of [400, 401, 403, 429, 500, 503]) {
    await t.test(`HTTP ${status}`, async () => {
      let calls = 0;
      const provider = createEmailProvider(env(), { fetchImpl: async () => { calls++; return response(status, { message: 'provider detail must not be logged' }); }, logger: {} });
      const expected = status >= 500 ? 'unknown' : 'rejected';
      await assert.rejects(provider.send({ to: 'person@example.com', ...email }), { outcome: expected, httpStatus: status });
      assert.equal(calls, 1);
    });
  }
});

test('timeouts and network errors are uncertain and do not leak provider errors or retry', async t => {
  for (const cause of [Object.assign(new Error('private body'), { name: 'TimeoutError' }), new Error('private socket detail')]) {
    await t.test(cause.name, async () => {
      let calls = 0;
      const logs = [];
      const provider = createEmailProvider(env(), { fetchImpl: async () => { calls++; throw cause; }, logger: { warn: value => logs.push(value) } });
      await assert.rejects(provider.send({ to: 'person@example.com', ...email }), { outcome: 'unknown' });
      assert.equal(calls, 1);
      assert.doesNotMatch(logs.join('\n'), /private-api-key-for-test|person@example\.com|private body|socket detail|012345/);
    });
  }
});

test('OTP templates include readable English and Spanish text and reject unsafe codes', () => {
  const en = verificationEmail({ code: '123456', expiresInMinutes: 10 });
  const es = verificationEmail({ code: '123456', expiresInMinutes: 10, language: 'es-MX' });
  assert.match(en.subject, /OpenGym verification code/);
  assert.match(en.text, /expires in 10 minutes/);
  assert.match(en.html, /lang="en"/);
  assert.match(en.html, /123456/);
  assert.match(en.text, /do not share this code/i);
  assert.match(es.subject, /código de verificación/);
  assert.match(es.text, /vence en 10 minutos/);
  assert.match(es.html, /lang="es"/);
  assert.throws(() => verificationEmail({ code: '<script>' }), /six digits/);
  assert.throws(() => verificationEmail({ code: '123456', expiresInMinutes: 0 }), /expiration/);
});
