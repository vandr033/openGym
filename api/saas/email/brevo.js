const ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const EMAIL = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

const error = (code, outcome, httpStatus) => Object.assign(new Error(code), { code, outcome, httpStatus });
const validEmail = value => typeof value === 'string' && value.length <= 254 && value === value.trim() && EMAIL.test(value);
const validDisplay = value => typeof value === 'string' && value.length > 0 && value.length <= 70 && !/[\u0000-\u001f\u007f]/.test(value);
const validContent = value => typeof value === 'string' && value.length > 0 && value.length <= 100_000 && !value.includes('\0');

function readConfig(env) {
  const apiKey = env.BREVO_API_KEY;
  const senderEmail = env.BREVO_SENDER_EMAIL;
  const senderName = env.BREVO_SENDER_NAME ?? 'OpenGym';
  const timeoutValue = env.BREVO_TIMEOUT_MS ?? '10000';
  const sandboxValue = env.BREVO_SANDBOX ?? '0';
  const timeoutMs = Number(timeoutValue);
  if (typeof apiKey !== 'string' || apiKey.length < 1 || apiKey.length > 512 || /\s|[\r\n]/.test(apiKey)) return null;
  if (!validEmail(senderEmail) || !validDisplay(senderName)) return null;
  if (!/^\d+$/.test(String(timeoutValue)) || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) return null;
  if (sandboxValue !== '0' && sandboxValue !== '1') return null;
  return { apiKey, senderEmail, senderName, timeoutMs, sandbox: sandboxValue === '1' };
}

function validMail(mail) {
  return !!mail && typeof mail === 'object' && !Array.isArray(mail)
    && validEmail(mail.to)
    && typeof mail.subject === 'string' && mail.subject.length > 0 && mail.subject.length <= 160
    && !/[\r\n\u0000]/.test(mail.subject)
    && (mail.text === undefined || validContent(mail.text))
    && (mail.html === undefined || validContent(mail.html))
    && (mail.text !== undefined || mail.html !== undefined);
}

async function responseData(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    while (size <= 8192) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); return null; }
      chunks.push(Buffer.from(value));
    }
  } catch { return null; }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

function log(logger, level, event, fields = {}) {
  try { logger?.[level]?.(JSON.stringify({ event, provider: 'brevo', ...fields })); } catch { /* logging must not change delivery outcome */ }
}

export function brevoEmailProvider(env = process.env, { fetchImpl = globalThis.fetch, logger = console } = {}) {
  const config = readConfig(env);
  if (!config || typeof fetchImpl !== 'function') {
    return {
      configured: false, sandbox: false,
      async send() { throw error('email_unconfigured', 'rejected'); }
    };
  }

  return {
    configured: true,
    sandbox: config.sandbox,
    async send(mail) {
      if (!validMail(mail)) throw error('email_invalid', 'rejected');
      const payload = {
        sender: { name: config.senderName, email: config.senderEmail },
        to: [{ email: mail.to }],
        subject: mail.subject,
        ...(mail.html !== undefined ? { htmlContent: mail.html } : {}),
        ...(mail.text !== undefined ? { textContent: mail.text } : {}),
        ...(config.sandbox ? { headers: { 'X-Sib-Sandbox': 'drop' } } : {})
      };
      let response;
      try {
        response = await fetchImpl(ENDPOINT, {
          method: 'POST',
          redirect: 'error',
          headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': config.apiKey },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(config.timeoutMs)
        });
      } catch (cause) {
        const timeout = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
        log(logger, 'warn', 'saas.email.provider.unknown', { reason: timeout ? 'timeout' : 'network' });
        throw error(timeout ? 'email_provider_timeout' : 'email_provider_network', 'unknown');
      }
      const body = await responseData(response);
      if (!response.ok) {
        const unknown = response.status >= 500;
        const code = response.status === 429 ? 'email_provider_rate_limited'
          : unknown ? 'email_provider_unavailable' : 'email_provider_rejected';
        log(logger, unknown ? 'warn' : 'error', unknown ? 'saas.email.provider.unknown' : 'saas.email.provider.rejected', {
          httpStatus: response.status, reason: code
        });
        throw error(code, unknown ? 'unknown' : 'rejected', response.status);
      }
      const submissionId = typeof body?.messageId === 'string' && body.messageId.length <= 255 && !/[\r\n]/.test(body.messageId)
        ? body.messageId : null;
      log(logger, 'info', config.sandbox ? 'saas.email.provider.sandbox_accepted' : 'saas.email.provider.accepted', {
        ...(submissionId ? { submissionId } : {})
      });
      return { status: config.sandbox ? 'SANDBOX' : 'ACCEPTED', ...(submissionId ? { submissionId } : {}) };
    }
  };
}
