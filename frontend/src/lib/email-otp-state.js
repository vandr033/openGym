const key = flow => `opengym-email-otp-${flow}`

export function readEmailOtpState(flow, context = null, now = Date.now()) {
  try {
    const raw = sessionStorage.getItem(key(flow))
    if (!raw) return null
    const saved = JSON.parse(raw)
    if (!saved || !Number.isFinite(saved.expiresAt)) { sessionStorage.removeItem(key(flow)); return null }
    if (saved.expiresAt <= now) { sessionStorage.removeItem(key(flow)); return null }
    if (context && saved.context !== context) return null
    return saved
  } catch { return null }
}

export function writeEmailOtpState(flow, state) {
  try { sessionStorage.setItem(key(flow), JSON.stringify(state)) } catch { /* storage may be unavailable */ }
}

export function clearEmailOtpState(flow) {
  try { sessionStorage.removeItem(key(flow)) } catch { /* storage may be unavailable */ }
}
