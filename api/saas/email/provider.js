import { brevoEmailProvider } from './brevo.js';

const unavailable = () => ({
  configured: false,
  sandbox: false,
  async send() { throw Object.assign(new Error('email provider is not configured'), { code: 'email_unconfigured', outcome: 'rejected' }); }
});

export function createEmailProvider(env = process.env, options = {}) {
  switch (String(env.EMAIL_PROVIDER || '').trim().toLowerCase()) {
    case 'brevo': return brevoEmailProvider(env, options);
    default: return unavailable();
  }
}

export function createEmailDelivery(env = process.env, transport = null, options = {}) {
  if (transport && typeof transport.send === 'function') {
    return { configured: true, sandbox: false, send: mail => transport.send(mail) };
  }
  return createEmailProvider(env, options);
}
