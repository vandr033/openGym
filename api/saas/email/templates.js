const copy = {
  en: {
    subject: 'Your OpenGym verification code',
    heading: 'Verify your email',
    intro: 'Use this code to continue with OpenGym:',
    expires: minutes => `This code expires in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
    ignore: 'If you did not request this code, you can ignore this email.',
    security: 'For your security, do not share this code with anyone.',
    footer: 'OpenGym · Your training, your data.'
  },
  es: {
    subject: 'Tu código de verificación de OpenGym',
    heading: 'Verifica tu correo',
    intro: 'Usa este código para continuar en OpenGym:',
    expires: minutes => `Este código vence en ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}.`,
    ignore: 'Si no solicitaste este código, puedes ignorar este correo.',
    security: 'Por tu seguridad, no compartas este código con nadie.',
    footer: 'OpenGym · Tu entrenamiento, tus datos.'
  }
};

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function verificationEmail({ code, expiresInMinutes = 10, language = 'en' }) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new TypeError('verification code must be six digits');
  if (!Number.isInteger(expiresInMinutes) || expiresInMinutes < 1 || expiresInMinutes > 120) throw new TypeError('expiration must be between 1 and 120 minutes');
  const lang = String(language).toLowerCase().startsWith('es') ? 'es' : 'en';
  const text = copy[lang];
  const safeCode = escapeHtml(code);
  const expiry = text.expires(expiresInMinutes);
  return {
    subject: text.subject,
    text: `OpenGym\n\n${text.heading}\n${text.intro}\n\n${code}\n\n${expiry}\n${text.ignore}\n${text.security}\n\n${text.footer}`,
    html: `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head><body style="margin:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#17212b"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6f8;padding:28px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background:#fff;border-radius:16px"><tr><td style="padding:28px 26px 24px"><div style="font-size:13px;font-weight:700;letter-spacing:.08em;color:#55715c">OpenGym</div><h1 style="font-size:24px;line-height:1.25;margin:22px 0 10px">${text.heading}</h1><p style="font-size:15px;line-height:1.5;margin:0 0 18px;color:#45515c">${text.intro}</p><div style="background:#f3f7f2;border-radius:12px;text-align:center;padding:17px 12px;font-size:32px;font-weight:700;letter-spacing:.24em;color:#243e2b">${safeCode}</div><p style="font-size:14px;line-height:1.5;margin:18px 0 8px;color:#45515c">${expiry}</p><p style="font-size:14px;line-height:1.5;margin:0 0 8px;color:#45515c">${text.ignore}</p><p style="font-size:14px;line-height:1.5;margin:0;color:#45515c">${text.security}</p><div style="border-top:1px solid #e7ebee;margin-top:24px;padding-top:16px;font-size:12px;color:#7b8791">${text.footer}</div></td></tr></table></td></tr></table></body></html>`
  };
}
