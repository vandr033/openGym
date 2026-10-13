import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { useUI } from '../store/useUI.js'
import { ProveOwner } from './PasswordAuth.jsx'
import { Button, Row } from './ui.jsx'

const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) })
const ui = () => useUI.getState()

function LinkEmailSheet({ passkeys, password, close, done }) {
  const [email, setEmail] = useState('')
  const [challengeId, setChallengeId] = useState('')
  const [code, setCode] = useState('')
  const [seconds, setSeconds] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!seconds) return
    const timer = setTimeout(() => setSeconds(value => Math.max(0, value - 1)), 1000)
    return () => clearTimeout(timer)
  }, [seconds])

  const request = async proof => {
    if (!email.trim()) { setError(t('Enter an e-mail address.')); throw new Error(t('E-mail address is required.')) }
    const result = await post('/api/v2/auth/email/link/request', { email: email.trim(), ...proof })
    if (result.alreadyVerified) { done(); close(); return }
    setChallengeId(result.challengeId); setSeconds(result.resendAfter || 60); setCode('')
  }

  const verify = async ev => {
    ev.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try {
      const result = await post('/api/v2/auth/email/link/verify', { challengeId, code })
      done(result); close(); ui().toast(t('Verified e-mail linked to your account.'))
    } catch (e) { setError(e.message || t('That code is invalid or expired.')) }
    finally { setBusy(false) }
  }

  return <>
    <h3>{t('Link a verified e-mail')}</h3>
    <div className="small muted" style={{ marginBottom: 12 }}>{t('Confirm it is you, then verify the new address. Your existing sign-in e-mail is not used for account recovery.')}</div>
    {!challengeId ? <>
      <label className="stack small" style={{ marginBottom: 12 }}>{t('E-mail address')}
        <input className="input" type="email" autoComplete="email" inputMode="email" maxLength={254} value={email} onChange={e => setEmail(e.target.value)} required />
      </label>
      <ProveOwner passkey={passkeys} password={password} submitText={t('Send verification code')} onProof={request} />
    </> : <form onSubmit={verify}>
      <div className="small muted" style={{ marginBottom: 10 }}>{t('Enter the six-digit code sent to {0}.', email)}</div>
      <input className="input" inputMode="numeric" autoComplete="one-time-code" aria-label={t('Six-digit e-mail code')} maxLength={6} pattern="[0-9]{6}"
        value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} required />
      <div className="small dim" style={{ marginTop: 6 }}>{t('The code expires in 10 minutes. Never share your code.')}</div>
      {error && <div className="small" role="alert" style={{ color: 'var(--red)', marginTop: 8 }}>{error}</div>}
      <div style={{ height: 12 }} /><Button type="submit" variant="primary" disabled={busy || code.length !== 6}>{t('Verify and link e-mail')}</Button>
      <div className="small dim" style={{ marginTop: 8 }}>{seconds ? t('To request another code, start again in {0}s.', seconds) : <Button size="sm" variant="ghost" onClick={() => { setChallengeId(''); setError('') }}>{t('Start again')}</Button>}</div>
    </form>}
    <div style={{ height: 8 }} /><Button variant="ghost" className="dim" onClick={close}>{t('Cancel')}</Button>
  </>
}

export default function VerifiedEmailRow({ passkeys, password, enabled }) {
  const [status, setStatus] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const load = () => api('/api/v2/auth/email/status').then(result => { setStatus(result); setLoaded(true) }).catch(() => setLoaded(true))
  useEffect(() => { if (enabled) load() }, [enabled])
  if (!enabled) return null
  const linked = !!status?.email
  return <Row icon="envelope" iconTint="var(--blue)" title={t('Verified e-mail')}
    subtitle={linked ? t('{0} · verified', status.email) : loaded ? t('Not set — link an e-mail for one-time-code sign-in.') : t('Checking verified e-mail…')}
    accessory={linked ? 'none' : 'chevron'} onClick={!linked ? () => ui().openSheet(close => <LinkEmailSheet passkeys={passkeys} password={password} close={close} done={load} />) : undefined} />
}
