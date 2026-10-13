import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../lib/api.js'
import { LANGS, t } from '../lib/i18n.js'
import { MOBILE } from '../lib/mobile.js'
import { askAddDeviceData } from '../sheets.jsx'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { Button, Segmented } from '../components/ui.jsx'
import { clearEmailOtpState, readEmailOtpState, writeEmailOtpState } from '../lib/email-otp-state.js'

const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) })
const roleName = invitation => invitation?.role ? t(invitation.role) : ''

export default function Join() {
  const { token } = useParams()
  const nav = useNavigate()
  const user = useStore(state => state.user)
  const config = useStore(state => state.config)
  const [saved] = useState(() => readEmailOtpState('join', token || null))
  const [preview, setPreview] = useState(null)
  const [inviteCode, setInviteCode] = useState(!token ? saved?.invitationRef || '' : '')
  const [email, setEmail] = useState(saved?.email || '')
  const [challengeId, setChallengeId] = useState(saved?.challengeId || '')
  const [useEmailLogin, setUseEmailLogin] = useState(false)
  const [emailCode, setEmailCode] = useState('')
  const [registrationState, setRegistrationState] = useState(saved?.registrationState || '')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [unit, setUnit] = useState('kg')
  const [lang, setLang] = useState(config?.default_lang || 'en')
  const [seconds, setSeconds] = useState(Math.max(0, Math.ceil(((saved?.resendAt || 0) - Date.now()) / 1000)))
  const [resendAt, setResendAt] = useState(saved?.resendAt || 0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [accepted, setAccepted] = useState(null)
  const [grants, setGrants] = useState({})
  const [grantDays, setGrantDays] = useState('90')

  useEffect(() => {
    if (!token) return
    let live = true
    post('/api/v2/invitations/preview', { token })
      .then(result => { if (live) { setPreview(result.invitation); setError('') } })
      .catch(e => { if (live) setError(e.message || t('This invitation is unavailable or expired.')) })
    return () => { live = false }
  }, [token])

  useEffect(() => {
    if (token || !registrationState || !inviteCode.trim()) return
    let live = true
    post('/api/v2/invitations/preview', { code: inviteCode.trim(), registrationState })
      .then(result => { if (live) setPreview(result.invitation) })
      .catch(e => { if (live) setError(e.message || t('This invitation is unavailable or expired.')) })
    return () => { live = false }
  }, [token, registrationState, inviteCode])

  useEffect(() => {
    if (!seconds) return
    const timer = setTimeout(() => setSeconds(value => Math.max(0, value - 1)), 1000)
    return () => clearTimeout(timer)
  }, [seconds])

  const invitationRef = token || inviteCode.trim()
  const requestCode = async ev => {
    ev?.preventDefault()
    if (busy) return
    if (!email.trim() || (!token && !/^\d{6}$/.test(inviteCode))) {
      setError(t('Enter your e-mail and the six-digit invitation code.'))
      return
    }
    setBusy(true); setError('')
    try {
      const result = await post('/api/v2/auth/email/request', { email: email.trim(), purpose: 'INVITATION', invitationRef })
      const now = Date.now(), wait = (result.resendAfter || 60) * 1000
      const context = token || inviteCode.trim()
      const next = { context, invitationRef, email: email.trim(), challengeId: result.challengeId, expiresAt: now + 10 * 60000, resendAt: now + wait }
      writeEmailOtpState('join', next)
      setChallengeId(next.challengeId); setSeconds(Math.ceil(wait / 1000)); setResendAt(next.resendAt); setEmailCode('')
    } catch (e) { setError(e.message || t('Could not request an e-mail code.')) }
    finally { setBusy(false) }
  }

  const recordAcceptance = result => {
    setAccepted(result)
    setError('')
  }

  const accept = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { recordAcceptance(await post('/api/v2/invitations/accept', token ? { token } : { code: inviteCode.trim() })) }
    catch (e) { setError(e.message || t('Sign in with the invited e-mail address to accept this invitation.')) }
    finally { setBusy(false) }
  }

  const verifyCode = async ev => {
    ev.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try {
      const result = await post('/api/v2/auth/email/verify', { challengeId, code: emailCode })
      if (result.user) {
        clearEmailOtpState('join')
        if (result.invitation) setPreview(result.invitation)
        const st = useStore.getState()
        st.setUser(result.user, { adopt: true })
        await st.adoptProfile(askAddDeviceData)
        recordAcceptance(await post('/api/v2/invitations/accept', token ? { token } : { code: inviteCode.trim() }))
      } else if (result.registrationState) {
        const verifiedEmail = result.email || email
        const expiry = Date.now() + 30 * 60000
        writeEmailOtpState('join', { context: token || inviteCode.trim(), invitationRef, email: verifiedEmail, challengeId, registrationState: result.registrationState, expiresAt: expiry, resendAt })
        setRegistrationState(result.registrationState)
        setEmail(verifiedEmail)
        if (result.invitation) setPreview(result.invitation)
      } else throw new Error(t('That code is invalid or expired.'))
    } catch (e) { setError(e.message || t('That code is invalid or expired.')) }
    finally { setBusy(false) }
  }

  const finish = async ev => {
    ev.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try {
      const result = await post('/api/v2/onboarding/complete', {
        registrationState, invitationRef, name: name.trim(), phone: phone.trim() || undefined,
        preferences: { unit, lang }
      })
      clearEmailOtpState('join')
      const st = useStore.getState()
      st.setUser(result.user, { adopt: true })
      await st.adoptProfile(askAddDeviceData)
      recordAcceptance(result.accepted || {})
    } catch (e) { setError(e.message || t('Could not finish creating your profile.')) }
    finally { setBusy(false) }
  }

  const grantConsent = async () => {
    const relationshipId = accepted?.relationship?.id
    if (!relationshipId || busy) return
    const scopes = Object.entries(grants).filter(([, checked]) => checked).map(([scope]) => scope)
    if (!scopes.length) return continueToApp()
    setBusy(true); setError('')
    try {
      await api(`/api/v2/coaching/relationships/${relationshipId}/grants`, {
        method: 'PUT', body: JSON.stringify({ scopes, expiresAt: new Date(Date.now() + Number(grantDays) * 86400000).toISOString() })
      })
      continueToApp()
    } catch (e) { setError(e.message || t('Could not save your permissions.')) }
    finally { setBusy(false) }
  }

  const continueToApp = () => nav(preview?.role === 'CLIENT' && config?.collab_workouts ? '/collab' : config?.saas_invites_v2 ? '/organization' : '/home', { replace: true })
  const client = preview?.role === 'CLIENT'

  return <div className="narrow" style={{ paddingTop: 'max(28px, env(safe-area-inset-top))', paddingBottom: 40 }}>
    <div className="hdr"><div style={{ flex: 1 }}><h1>{t('Join a gym')}</h1></div></div>

    {!config?.saas_invites_v2 ? <div className="card" role="status">{t('Invitations are not available on this server.')}</div>
      : MOBILE ? <div className="card" role="status">{t('Invitation sign-in is available in a web browser. Open this invitation on the web app to continue.')}</div> : <>
      {preview && !accepted && <section className="card" aria-label={t('Invitation details')}>
        <div className="lbl2">{preview.organization.name}</div>
        <div className="small muted" style={{ marginTop: 6 }}>{t('Invited as {0}', roleName(preview))}</div>
        <div className="small muted">{t('Invited e-mail')}: {preview.email}</div>
        <div className="small dim">{t('Expires {0}', new Date(preview.expiresAt).toLocaleString())}</div>
      </section>}

      {!token && !challengeId && !registrationState && !accepted && <form className="card" onSubmit={requestCode}>
        <div className="lbl2">{t('Use an invitation code')}</div>
        <div className="small muted" style={{ margin: '5px 0 12px' }}>{t('Enter the e-mail address the invitation was sent to. We will verify it before showing the organization.')}</div>
        <label className="stack small">{t('E-mail address')}
          <input className="input" type="email" name="email" autoComplete="email" inputMode="email" maxLength={254} value={email} onChange={e => setEmail(e.target.value)} required />
        </label>
        <div style={{ height: 10 }} />
        <label className="stack small">{t('Six-digit invitation code')}
          <input className="input" inputMode="numeric" autoComplete="off" maxLength={6} value={inviteCode} onChange={e => setInviteCode(e.target.value.replace(/\D/g, '').slice(0, 6))} required />
        </label>
        <div style={{ height: 12 }} /><Button type="submit" variant="primary" disabled={busy}>{t('Verify e-mail')}</Button>
      </form>}

      {token && !preview && !accepted && <div className="card small muted" role="status">{t('Checking invitation…')}</div>}

      {preview && !user && !registrationState && !accepted && <form className="card" onSubmit={challengeId ? verifyCode : requestCode}>
        <div className="lbl2">{challengeId ? t('Check your e-mail') : t('Verify your e-mail')}</div>
        {!challengeId ? <>
          <div className="small muted" style={{ margin: '5px 0 12px' }}>{t('We will send a separate sign-in code to the invited address. The invitation link alone does not sign you in.')}</div>
          <label className="stack small">{t('E-mail address')}
            <input className="input" type="email" name="email" autoComplete="email" inputMode="email" maxLength={254} value={email} onChange={e => setEmail(e.target.value)} required />
          </label>
          <div style={{ height: 12 }} /><Button type="submit" variant="primary" disabled={busy}>{t('Send e-mail code')}</Button>
        </> : <>
          <div className="small muted" style={{ margin: '5px 0 12px' }}>{t('Enter the six-digit code sent to {0}.', email)}</div>
          <input className="input" inputMode="numeric" autoComplete="one-time-code" aria-label={t('Six-digit e-mail code')} maxLength={6} pattern="[0-9]{6}"
            value={emailCode} onChange={e => setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))} required />
          <div className="small dim" style={{ marginTop: 6 }}>{t('The code expires in 10 minutes. Never share your code.')}</div>
          <div style={{ height: 12 }} /><Button type="submit" variant="primary" disabled={busy || emailCode.length !== 6}>{t('Verify code')}</Button>
          <div className="small dim" style={{ marginTop: 8 }}>{seconds ? t('Resend available in {0}s', seconds) : <button type="button" className="linkbtn" disabled={busy} onClick={requestCode}>{t('Send another code')}</button>}</div>
        </>}
      </form>}

      {challengeId && !preview && !accepted && <form className="card" onSubmit={verifyCode}>
        <div className="lbl2">{t('Check your e-mail')}</div>
        <div className="small muted" style={{ margin: '5px 0 12px' }}>{t('Enter the separate six-digit verification code sent to {0}.', email)}</div>
        <input className="input" inputMode="numeric" autoComplete="one-time-code" aria-label={t('Six-digit e-mail code')} maxLength={6} pattern="[0-9]{6}"
          value={emailCode} onChange={e => setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))} required />
        <div className="small dim" style={{ marginTop: 6 }}>{t('The code expires in 10 minutes. Never share your code.')}</div>
        <div style={{ height: 12 }} /><Button type="submit" variant="primary" disabled={busy || emailCode.length !== 6}>{t('Verify code')}</Button>
        <div className="small dim" style={{ marginTop: 8 }}>{seconds ? t('Resend available in {0}s', seconds) : <button type="button" className="linkbtn" disabled={busy} onClick={requestCode}>{t('Send another code')}</button>}</div>
      </form>}

      {user && preview && !accepted && !registrationState && <section className="card">
        <div className="small muted" style={{ marginBottom: 10 }}>{t('You are signed in as {0}. The server checks that your verified e-mail matches this invitation.', user.name)}</div>
        <Button variant="primary" disabled={busy} onClick={accept}>{t('Accept invitation')}</Button>
        <div className="small dim" style={{ marginTop: 8 }}>{t('If this invitation was sent to another verified e-mail, sign in to that account first.')}</div>
        {!useEmailLogin && <Button variant="ghost" className="dim" onClick={() => setUseEmailLogin(true)}>{t('Sign in with invited e-mail')}</Button>}
      </section>}

      {user && preview && useEmailLogin && !challengeId && !accepted && <form className="card" onSubmit={requestCode}>
        <div className="lbl2">{t('Sign in with invited e-mail')}</div>
        <label className="stack small" style={{ marginTop: 8 }}>{t('E-mail address')}
          <input className="input" type="email" autoComplete="email" inputMode="email" maxLength={254} value={email} onChange={e => setEmail(e.target.value)} required />
        </label>
        <div style={{ height: 12 }} /><Button type="submit" variant="primary" disabled={busy}>{t('Send e-mail code')}</Button>
      </form>}

      {user && preview && useEmailLogin && challengeId && !accepted && <form className="card" onSubmit={verifyCode}>
        <div className="lbl2">{t('Check your e-mail')}</div>
        <div className="small muted" style={{ margin: '5px 0 12px' }}>{t('Enter the separate six-digit verification code sent to {0}.', email)}</div>
        <input className="input" inputMode="numeric" autoComplete="one-time-code" aria-label={t('Six-digit e-mail code')} maxLength={6} pattern="[0-9]{6}"
          value={emailCode} onChange={e => setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))} required />
        <div className="small dim" style={{ marginTop: 6 }}>{t('The code expires in 10 minutes. Never share your code.')}</div>
        <div style={{ height: 12 }} /><Button type="submit" variant="primary" disabled={busy || emailCode.length !== 6}>{t('Verify code')}</Button>
        <div className="small dim" style={{ marginTop: 8 }}>{seconds ? t('Resend available in {0}s', seconds) : <button type="button" className="linkbtn" disabled={busy} onClick={requestCode}>{t('Send another code')}</button>}</div>
      </form>}

      {registrationState && !accepted && <form className="card" onSubmit={finish}>
        <div className="lbl2">{t('Finish your profile')}</div>
        <div className="small muted" style={{ margin: '5px 0 12px' }}>{t('Verified e-mail')}: {email}</div>
        <label className="stack small">{t('Full name')}
          <input className="input" autoComplete="name" maxLength={40} value={name} onChange={e => setName(e.target.value)} required />
        </label>
        <div style={{ height: 10 }} />
        <label className="stack small">{t('Phone (optional)')}
          <input className="input" type="tel" autoComplete="tel" placeholder="+12345678900" maxLength={16} value={phone} onChange={e => setPhone(e.target.value)} />
        </label>
        <div className="small dim" style={{ marginTop: 5 }}>{t('Phone is optional, stored for your profile, and is not used for verification or sign-in.')}</div>
        <div style={{ height: 14 }} /><div className="small" style={{ marginBottom: 7 }}>{t('Weight units')}</div>
        <Segmented options={[{ value: 'kg', label: t('kg') }, { value: 'lb', label: t('lb') }]} value={unit} onChange={setUnit} />
        <div style={{ height: 12 }} />
        <label className="stack small">{t('Language')}
          <select className="input" value={lang} onChange={e => setLang(e.target.value)}>{Object.entries(LANGS).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select>
        </label>
        <div style={{ height: 14 }} /><Button type="submit" variant="primary" disabled={busy || !name.trim()}>{t('Create profile and join')}</Button>
      </form>}

      {accepted && <section className="card">
        <div className="lbl2">{t('You joined {0}', preview?.organization?.name || t('the organization'))}</div>
        <div className="small muted" style={{ margin: '5px 0 12px' }}>{t('Your role is {0}.', roleName(preview))}</div>
        {client && accepted.relationship?.id ? <>
          <div className="small" style={{ marginBottom: 8 }}>{t('Your trainer can only access the permissions you choose. You can change or revoke them later.')}</div>
          {[
            ['VIEW_TRAINING', t('Let this trainer view my workouts')],
            ['START_SESSION', t('Let this trainer start a workout session')],
            ['LOG_SETS', t('Let this trainer log sets for me')]
          ].map(([scope, label]) => <label key={scope} className="row" style={{ justifyContent: 'flex-start', gap: 10, minHeight: 44 }}>
            <input type="checkbox" checked={!!grants[scope]} onChange={e => setGrants(value => ({ ...value, [scope]: e.target.checked }))} />
            <span>{label}</span>
          </label>)}
          <label className="stack small" style={{ marginTop: 8 }}>{t('Permission duration')}
            <select className="input" value={grantDays} onChange={e => setGrantDays(e.target.value)}><option value="30">{t('30 days')}</option><option value="90">{t('90 days')}</option><option value="365">{t('1 year')}</option></select>
          </label>
          <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <Button variant="primary" disabled={busy || !Object.values(grants).some(Boolean)} onClick={grantConsent}>{t('Save chosen permissions')}</Button>
            <Button variant="ghost" disabled={busy} onClick={continueToApp}>{t('Continue without granting access')}</Button>
          </div>
        </> : <Button variant="primary" disabled={busy} onClick={continueToApp}>{t('Continue')}</Button>}
      </section>}
    </>}

    {error && <div className="small" role="alert" style={{ color: 'var(--red)', marginTop: 10 }}>{error}</div>}
  </div>
}
