import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { copyText } from '../lib/clipboard.js'
import { t } from '../lib/i18n.js'
import { confirmSheet } from '../sheets.jsx'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { Button, Segmented } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'

const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) })
const dateText = value => value ? new Date(value).toLocaleDateString() : '—'
const appUrl = token => `${window.location.origin}${window.location.pathname}#/join/${token}`

function InvitationSecret({ value, onDismiss }) {
  if (!value) return null
  const copy = async text => {
    if (await copyText(text)) useUI.getState().toast(t('Copied'))
    else useUI.getState().toast(t('Could not copy'))
  }
  return <section className="card" aria-live="polite">
    <div className="lbl2">{t('Invitation generated')}</div>
    <div className="small muted" style={{ margin: '5px 0 10px' }}>{t('This link and code are shown only now. Share them only with the invited person.')}</div>
    <div className="small dim">{t('Expires {0}', dateText(value.invitation?.expiresAt))} · {t('E-mail status: {0}', value.deliveryStatus || 'NOT_SENT')}</div>
    <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
      <Button size="sm" variant="tinted" icon="copy" onClick={() => copy(appUrl(value.token))}>{t('Copy link')}</Button>
      {value.code && <Button size="sm" variant="tinted" icon="copy" onClick={() => copy(value.code)}>{t('Copy invitation code')}</Button>}
      <Button size="sm" variant="ghost" onClick={onDismiss}>{t('Done')}</Button>
    </div>
  </section>
}

export default function Organization() {
  const nav = useNavigate()
  const user = useStore(state => state.user)
  const config = useStore(state => state.config)
  const [organizations, setOrganizations] = useState([])
  const [organizationId, setOrganizationId] = useState('')
  const [currentUserId, setCurrentUserId] = useState('')
  const [platformOrganizations, setPlatformOrganizations] = useState(null)
  const [platformForm, setPlatformForm] = useState(false)
  const [orgForm, setOrgForm] = useState(false)
  const [members, setMembers] = useState([])
  const [trainers, setTrainers] = useState([])
  const [clients, setClients] = useState([])
  const [invitations, setInvitations] = useState([])
  const [tab, setTab] = useState('Trainers')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [generated, setGenerated] = useState(null)
  const [form, setForm] = useState({ role: 'TRAINER', email: '', trainerId: '', expiresInDays: '7', sendEmail: false })
  const [platform, setPlatform] = useState({ type: 'GYM', name: '', slug: '', ownerEmail: '', sendEmail: false })

  const selected = organizations.find(row => row.id === organizationId) || organizations[0]
  const role = selected?.membershipRole
  const canManage = ['OWNER', 'ADMIN', 'TRAINER'].includes(role)
  const tabs = role === 'TRAINER' ? ['Clients', 'Invitations']
    : ['OWNER', 'ADMIN'].includes(role) ? ['Trainers', 'Clients', 'Team', 'Invitations'] : []

  const loadPeople = async id => {
    const org = organizations.find(row => row.id === id)
    if (!org) return
    setError(''); setMembers([]); setTrainers([]); setClients([]); setInvitations([])
    const requests = [
      ['trainers', `/api/v2/organizations/${id}/trainers`],
      ['clients', `/api/v2/organizations/${id}/clients`],
      ['invitations', `/api/v2/organizations/${id}/invitations`],
      ...(['OWNER', 'ADMIN'].includes(org.membershipRole) ? [['members', `/api/v2/organizations/${id}/members`]] : [])
    ]
    const results = await Promise.allSettled(requests.map(([, path]) => api(path)))
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled') return
      const key = requests[index][0]
      if (key === 'trainers') setTrainers(result.value.trainers || [])
      if (key === 'clients') setClients(result.value.clients || [])
      if (key === 'invitations') setInvitations(result.value.invitations || [])
      if (key === 'members') setMembers(result.value.members || [])
    })
    if (results.every(result => result.status === 'rejected')) setError(t('Could not load organization people.'))
  }

  useEffect(() => {
    let live = true
    Promise.allSettled([api('/api/v2/organizations/me'), api('/api/v2/platform/organizations')]).then(([mine, platformResult]) => {
      if (!live) return
      if (mine.status === 'fulfilled') {
        setOrganizations(mine.value.organizations || [])
        setOrganizationId(mine.value.organizations?.[0]?.id || '')
        setCurrentUserId(mine.value.userId || '')
      }
      if (platformResult.status === 'fulfilled') setPlatformOrganizations(platformResult.value.organizations || [])
      setLoading(false)
    })
    return () => { live = false }
  }, [])

  useEffect(() => {
    if (organizationId) loadPeople(organizationId)
  }, [organizationId, organizations.length])

  useEffect(() => {
    if (role === 'TRAINER') setForm(value => ({ ...value, role: 'CLIENT', trainerId: currentUserId }))
    else if (['OWNER', 'ADMIN'].includes(role)) setForm(value => ({ ...value, role: 'TRAINER', trainerId: '' }))
    setTab(role === 'TRAINER' ? 'Clients' : 'Trainers')
  }, [role, currentUserId, organizationId, trainers.length])

  const inviteRoles = useMemo(() => role === 'OWNER'
    ? ['OWNER', 'ADMIN', 'TRAINER', 'STAFF', 'CLIENT']
    : role === 'ADMIN' ? ['ADMIN', 'TRAINER', 'STAFF', 'CLIENT']
      : role === 'TRAINER' ? ['CLIENT'] : [], [role])

  const generateInvitation = async ev => {
    ev.preventDefault()
    if (!selected || busy) return
    setBusy(true); setError(''); setGenerated(null)
    try {
      const result = await post(`/api/v2/organizations/${selected.id}/invitations`, {
        role: form.role, email: form.email.trim(),
        ...(form.role === 'CLIENT' ? { trainerId: role === 'TRAINER' ? currentUserId : form.trainerId } : {}),
        expiresInDays: Number(form.expiresInDays), sendEmail: form.sendEmail
      })
      setGenerated(result); setOrgForm(false); await loadPeople(selected.id)
    } catch (e) { setError(e.message || t('Could not create invitation.')) }
    finally { setBusy(false) }
  }

  const resendInvitation = async invitation => {
    setBusy(true); setError('')
    try {
      const result = await post(`/api/v2/organizations/${selected.id}/invitations/${invitation.id}/resend`, { sendEmail: true })
      setGenerated(result); await loadPeople(selected.id)
    } catch (e) { setError(e.message || t('Could not resend invitation.')) }
    finally { setBusy(false) }
  }

  const revokeInvitation = invitation => confirmSheet({
    title: t('Revoke this invitation?'), message: t('The invite link and invitation code will stop working.'), confirmText: t('Revoke'), danger: true,
    onConfirm: async () => {
      setBusy(true); setError('')
      try { await api(`/api/v2/organizations/${selected.id}/invitations/${invitation.id}`, { method: 'DELETE' }); await loadPeople(selected.id) }
      catch (e) { setError(e.message || t('Could not revoke invitation.')) }
      finally { setBusy(false) }
    }
  })

  const createOrganization = async ev => {
    ev.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try {
      const result = await post('/api/v2/platform/organizations', { ...platform, sendEmail: platform.sendEmail })
      setGenerated(result.ownerInvitation); setPlatformForm(false)
      const list = await api('/api/v2/platform/organizations')
      setPlatformOrganizations(list.organizations || [])
      setPlatform({ type: 'GYM', name: '', slug: '', ownerEmail: '', sendEmail: false })
    } catch (e) { setError(e.message || t('Could not create organization.')) }
    finally { setBusy(false) }
  }

  const copy = async value => {
    if (await copyText(value)) useUI.getState().toast(t('Copied'))
    else useUI.getState().toast(t('Could not copy'))
  }

  return <div className="narrow" style={{ paddingBottom: 40 }}>
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/home')} aria-label={t('Home')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 10 }}><h1>{t('Organization')}</h1></div>
    </div>

    {generated && <InvitationSecret value={generated} onDismiss={() => setGenerated(null)} />}

    {platformOrganizations && <section className="card">
      <div className="row between"><div><div className="lbl2">{t('Platform organizations')}</div><div className="small muted">{t('Create a gym and invite its first owner by verified e-mail.')}</div></div>
        <Button size="sm" variant="tinted" onClick={() => setPlatformForm(value => !value)}>{platformForm ? t('Cancel') : t('New organization')}</Button></div>
      {platformForm && <form onSubmit={createOrganization} style={{ marginTop: 12 }}>
        <label className="stack small">{t('Organization name')}<input className="input" maxLength={120} value={platform.name} onChange={e => setPlatform(value => ({ ...value, name: e.target.value }))} required /></label>
        <div style={{ height: 8 }} /><label className="stack small">{t('Slug')}<input className="input" maxLength={80} pattern="[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?" value={platform.slug} onChange={e => setPlatform(value => ({ ...value, slug: e.target.value }))} required /></label>
        <div style={{ height: 8 }} /><label className="stack small">{t('Type')}<select className="input" value={platform.type} onChange={e => setPlatform(value => ({ ...value, type: e.target.value }))}><option value="GYM">{t('Gym')}</option><option value="TRAINER_BUSINESS">{t('Trainer business')}</option></select></label>
        <div style={{ height: 8 }} /><label className="stack small">{t('First owner e-mail')}<input className="input" type="email" autoComplete="email" maxLength={254} value={platform.ownerEmail} onChange={e => setPlatform(value => ({ ...value, ownerEmail: e.target.value }))} required /></label>
        <label className="row" style={{ gap: 8, justifyContent: 'flex-start', margin: '10px 0' }}><input type="checkbox" checked={platform.sendEmail} onChange={e => setPlatform(value => ({ ...value, sendEmail: e.target.checked }))} />{t('Send invitation e-mail')}</label>
        <Button type="submit" variant="primary" disabled={busy}>{t('Create organization and owner invitation')}</Button>
      </form>}
      <div className="small dim" style={{ marginTop: 10 }}>{t('{0} organization(s)', platformOrganizations.length)}</div>
    </section>}

    {loading ? <div className="card small muted" role="status">{t('Loading…')}</div> : organizations.length > 0 && <>
      {organizations.length > 1 && <label className="stack small" style={{ margin: '8px 0 12px' }}>{t('Organization')}
        <select className="input" value={selected?.id || ''} onChange={e => setOrganizationId(e.target.value)}>{organizations.map(org => <option key={org.id} value={org.id}>{org.name} · {org.membershipRole || t('CLIENT')}</option>)}</select>
      </label>}
      {selected && <section className="card">
        <div className="row between"><div><div className="lbl2">{selected.name}</div><div className="small muted">{t('Your role: {0}', selected.membershipRole || t('CLIENT'))}</div></div></div>
        {tabs.length > 0 && <>
          <div style={{ height: 12 }} /><Segmented className="seg-range" options={tabs.map(value => ({ value, label: t(value) }))} value={tabs.includes(tab) ? tab : tabs[0]} onChange={setTab} />
          {tab === 'Invitations' && <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}><Button size="sm" variant="primary" onClick={() => setOrgForm(value => !value)}>{orgForm ? t('Cancel') : t('Invite')}</Button></div>}
        </>}
      </section>}

      {orgForm && <form className="card" onSubmit={generateInvitation}>
        <div className="lbl2">{t('Invite someone')}</div>
        <label className="stack small" style={{ marginTop: 10 }}>{t('Role')}<select className="input" value={form.role} onChange={e => setForm(value => ({ ...value, role: e.target.value }))}>{inviteRoles.map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>
        <div style={{ height: 8 }} /><label className="stack small">{t('E-mail address')}<input className="input" type="email" autoComplete="email" maxLength={254} value={form.email} onChange={e => setForm(value => ({ ...value, email: e.target.value }))} required /></label>
        {form.role === 'CLIENT' && <>
          <div className="small muted" style={{ marginTop: 8 }}>{t('Choose the trainer for this client. Accepting the invitation does not grant workout permissions.')}</div>
          {role === 'TRAINER' ? <div className="small" style={{ marginTop: 6 }}>{t('Assigned trainer: {0}', user?.name || t('you'))}</div>
            : <label className="stack small" style={{ marginTop: 8 }}>{t('Assigned trainer')}<select className="input" value={form.trainerId} onChange={e => setForm(value => ({ ...value, trainerId: e.target.value }))} required><option value="">{t('Choose a trainer')}</option>{trainers.filter(row => ['OWNER', 'ADMIN', 'TRAINER'].includes(row.role)).map(row => <option key={row.userId} value={row.userId}>{row.displayName} · {t(row.role)}</option>)}</select></label>}
        </>}
        <label className="stack small" style={{ marginTop: 8 }}>{t('Invitation expires in')}<select className="input" value={form.expiresInDays} onChange={e => setForm(value => ({ ...value, expiresInDays: e.target.value }))}><option value="7">{t('7 days')}</option><option value="14">{t('14 days')}</option><option value="30">{t('30 days')}</option></select></label>
        <label className="row" style={{ gap: 8, justifyContent: 'flex-start', margin: '10px 0' }}><input type="checkbox" checked={form.sendEmail} onChange={e => setForm(value => ({ ...value, sendEmail: e.target.checked }))} />{t('Send invitation e-mail')}</label>
        <Button type="submit" variant="primary" disabled={busy || (form.role === 'CLIENT' && role !== 'TRAINER' && !trainers.length)}>{t('Generate invitation')}</Button>
      </form>}

      {tab === 'Trainers' && <section className="card"><div className="lbl2">{t('Trainers')}</div>{trainers.map(row => <div className="row between" key={row.userId} style={{ minHeight: 48, borderTop: '1px solid var(--line)' }}><span>{row.displayName || t('Unnamed')}</span><span className="tag">{t(row.role)}</span></div>)}{!trainers.length && <div className="small muted" style={{ marginTop: 8 }}>{t('No active trainers yet.')}</div>}</section>}
      {tab === 'Clients' && <section className="card"><div className="lbl2">{t('Clients')}</div>{clients.map(row => <div className="row between" key={row.userId} style={{ minHeight: 48, borderTop: '1px solid var(--line)' }}><span>{row.displayName || t('Unnamed')}</span><span className="small dim">{row.grantedScopes?.length ? t('{0} permission(s)', row.grantedScopes.length) : t('No permissions granted')}</span></div>)}{!clients.length && <div className="small muted" style={{ marginTop: 8 }}>{t('No active clients yet.')}</div>}</section>}
      {tab === 'Team' && <section className="card"><div className="lbl2">{t('Team')}</div>{members.map(row => <div className="row between" key={row.userId} style={{ minHeight: 48, borderTop: '1px solid var(--line)' }}><span>{row.displayName || t('Unnamed')}</span><span className="tag">{t(row.role)} · {t(row.status)}</span></div>)}{!members.length && <div className="small muted" style={{ marginTop: 8 }}>{t('No team members yet.')}</div>}</section>}
      {tab === 'Invitations' && <section className="card"><div className="lbl2">{t('Invitations')}</div>{invitations.map(row => <div key={row.id} style={{ borderTop: '1px solid var(--line)', padding: '12px 0' }}>
        <div className="row between"><div><div>{row.email || t('Existing account')}</div><div className="small muted">{t(row.role)} · {t(row.status)} · {t('Expires {0}', dateText(row.expiresAt))}</div><div className="small dim">{t('E-mail: {0}', row.deliveryStatus)}</div></div><Icon name="envelope" className="dim" /></div>
        {row.status === 'PENDING' && row.canManage && <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 7 }}><Button size="sm" variant="ghost" disabled={busy} onClick={() => resendInvitation(row)}>{t('Resend')}</Button><Button size="sm" variant="ghost" className="dim" disabled={busy} onClick={() => revokeInvitation(row)}>{t('Revoke')}</Button></div>}
      </div>)}{!invitations.length && <div className="small muted" style={{ marginTop: 8 }}>{t('No invitations yet.')}</div>}</section>}
    </>}

    {!loading && !organizations.length && !platformOrganizations && <div className="card small muted">{t('You do not have an organization role on this account.')}</div>}
    {!loading && organizations.length > 0 && !canManage && <div className="card small muted">{t('This account does not have permission to manage people in this organization.')}</div>}
    {error && <div role="alert" className="small" style={{ color: 'var(--red)', marginTop: 10 }}>{error}</div>}
  </div>
}
