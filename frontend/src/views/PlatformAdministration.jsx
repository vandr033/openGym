import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { api } from '../lib/api.js'
import { copyText } from '../lib/clipboard.js'
import { t } from '../lib/i18n.js'
import { confirmSheet } from '../sheets.jsx'
import { useUI } from '../store/useUI.js'
import { Button } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'

const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) })
const dateText = value => value ? new Date(value).toLocaleDateString() : '—'
const appUrl = token => `${window.location.origin}${window.location.pathname}#/join/${token}`
const typeLabel = type => type === 'TRAINER_BUSINESS' ? t('Independent Trainer') : t('Gym')

function InvitationSecret({ value, onDismiss }) {
  if (!value) return null
  const copy = async value => {
    if (await copyText(value)) useUI.getState().toast(t('Copied'))
    else useUI.getState().toast(t('Could not copy'))
  }
  return <section className="card" aria-live="polite">
    <div className="lbl2">{t('Owner invitation ready')}</div>
    <div className="small muted" style={{ margin: '5px 0 10px' }}>{t('The invited owner must verify this e-mail before joining.')}</div>
    <div className="small dim">{t('Expires {0}', dateText(value.invitation?.expiresAt))} · {t('E-mail status: {0}', value.deliveryStatus || 'NOT_SENT')}</div>
    <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
      <Button size="sm" variant="tinted" icon="copy" onClick={() => copy(appUrl(value.token))}>{t('Copy link')}</Button>
      {value.code && <Button size="sm" variant="tinted" icon="copy" onClick={() => copy(value.code)}>{t('Copy invitation code')}</Button>}
      <Button size="sm" variant="ghost" onClick={onDismiss}>{t('Done')}</Button>
    </div>
  </section>
}

const invitationStatus = row => row.status || (row.acceptedAt ? 'ACCEPTED' : row.revokedAt ? 'REVOKED' : new Date(row.expiresAt) <= new Date() ? 'EXPIRED' : 'PENDING')

export default function PlatformAdministration() {
  const nav = useNavigate()
  const location = useLocation()
  const { organizationId } = useParams()
  const [organizations, setOrganizations] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('ALL')
  const [statusFilter, setStatusFilter] = useState('ALL')
  const [showForm, setShowForm] = useState(false)
  const [generated, setGenerated] = useState(null)
  const [form, setForm] = useState({ type: 'GYM', name: '', slug: '', ownerEmail: '', sendEmail: true })

  const load = async () => {
    setError('')
    try {
      const result = await api('/api/v2/platform/organizations')
      setOrganizations(result.organizations || [])
      setSummary(result.summary || null)
    } catch (e) { setError(e.message || t('Could not load platform administration.')) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  const isTrainerPage = location.pathname === '/platform/trainers'
  const isOrgPage = location.pathname === '/platform/organizations'
  const organization = organizations.find(row => row.id === organizationId)
  const directoryRows = useMemo(() => organizations
    .filter(row => isTrainerPage ? row.type === 'TRAINER_BUSINESS' : row.type === 'GYM')
    .filter(row => isTrainerPage || typeFilter === 'ALL' || row.type === typeFilter)
    .filter(row => statusFilter === 'ALL' || row.status === statusFilter)
    .filter(row => `${row.name} ${row.slug} ${row.owners?.map(owner => `${owner.displayName || ''} ${owner.email || ''}`).join(' ')}`.toLowerCase().includes(query.toLowerCase().trim())),
  [organizations, isTrainerPage, typeFilter, statusFilter, query])

  const createOrganization = async event => {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError(''); setGenerated(null)
    try {
      const result = await post('/api/v2/platform/organizations', form)
      setGenerated(result.ownerInvitation)
      setShowForm(false)
      setForm({ type: isTrainerPage ? 'TRAINER_BUSINESS' : 'GYM', name: '', slug: '', ownerEmail: '', sendEmail: true })
      await load()
    } catch (e) { setError(e.message || t('Could not create organization.')) }
    finally { setBusy(false) }
  }

  const resendInvitation = async (org, invitation) => {
    setBusy(true); setError(''); setGenerated(null)
    try {
      const result = await post(`/api/v2/platform/organizations/${org.id}/invitations/${invitation.id}/resend`, { sendEmail: true })
      setGenerated(result); await load()
    } catch (e) { setError(e.message || t('Could not resend invitation.')) }
    finally { setBusy(false) }
  }

  const revokeInvitation = (org, invitation) => confirmSheet({
    title: t('Revoke this invitation?'), message: t('The invite link and invitation code will stop working.'), confirmText: t('Revoke'), danger: true,
    onConfirm: async () => {
      setBusy(true); setError('')
      try { await api(`/api/v2/platform/organizations/${org.id}/invitations/${invitation.id}`, { method: 'DELETE' }); await load() }
      catch (e) { setError(e.message || t('Could not revoke invitation.')) }
      finally { setBusy(false) }
    }
  })

  const openForm = type => {
    setForm(value => ({ ...value, type }))
    setShowForm(value => !value)
  }

  const title = organization ? organization.name : isTrainerPage ? t('Independent Trainers') : isOrgPage ? t('Organizations') : t('Platform Administration')

  return <main className="saas-admin">
    <header className="hdr">
      <button className="iconbtn" onClick={() => nav(organization ? '/platform/organizations' : '/home')} aria-label={t(organization ? 'Back' : 'Home')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 10 }}><h1>{title}</h1><div className="sub">{t('Manage gyms and independent trainer workspaces.')}</div></div>
    </header>

    <nav className="saas-admin-nav" aria-label={t('Platform administration')}>
      <Button size="sm" variant={location.pathname === '/platform' ? 'tinted' : 'ghost'} onClick={() => nav('/platform')}>{t('Overview')}</Button>
      <Button size="sm" variant={isOrgPage || !!organization && organization.type === 'GYM' ? 'tinted' : 'ghost'} onClick={() => nav('/platform/organizations')}>{t('Organizations')}</Button>
      <Button size="sm" variant={isTrainerPage || !!organization && organization.type === 'TRAINER_BUSINESS' ? 'tinted' : 'ghost'} onClick={() => nav('/platform/trainers')}>{t('Independent Trainers')}</Button>
    </nav>

    {generated && <InvitationSecret value={generated} onDismiss={() => setGenerated(null)} />}
    {loading && <div className="card small muted" role="status">{t('Loading…')}</div>}
    {error && <div role="alert" className="card small" style={{ color: 'var(--red)' }}>{error}</div>}

    {!loading && !error && location.pathname === '/platform' && <>
      <section className="saas-admin-stats" aria-label={t('Platform totals')}>
        {[[t('Gyms'), summary?.gyms], [t('Independent Trainers'), summary?.trainerBusinesses], [t('Trainers'), summary?.trainers], [t('Clients'), summary?.clients], [t('Pending invitations'), summary?.pendingInvitations]].map(([label, count]) => <div className="card" key={label}><div className="small muted">{label}</div><strong>{count ?? '—'}</strong></div>)}
      </section>
      <section className="saas-admin-links">
        <button className="card saas-admin-link" onClick={() => nav('/platform/organizations')}><span><b>{t('Organizations')}</b><span className="small muted">{t('Create and review gyms.')}</span></span><Icon name="chevronRight" /></button>
        <button className="card saas-admin-link" onClick={() => nav('/platform/trainers')}><span><b>{t('Independent Trainers')}</b><span className="small muted">{t('Create and review trainer workspaces.')}</span></span><Icon name="chevronRight" /></button>
      </section>
    </>}

    {!loading && !error && (isOrgPage || isTrainerPage) && <>
      <section className="card">
        <div className="row between" style={{ gap: 10, flexWrap: 'wrap' }}>
          <div><div className="lbl2">{isTrainerPage ? t('Independent Trainers') : t('Organizations')}</div><div className="small muted">{isTrainerPage ? t('Each trainer gets a personal workspace and verified owner invitation.') : t('Create a gym and invite its first owner by verified e-mail.')}</div></div>
          <Button size="sm" variant="primary" onClick={() => openForm(isTrainerPage ? 'TRAINER_BUSINESS' : 'GYM')}>{showForm ? t('Cancel') : isTrainerPage ? t('Invite independent trainer') : t('Create gym')}</Button>
        </div>
        {showForm && <form className="saas-admin-form" onSubmit={createOrganization}>
          <label className="stack small">{t('Name')}<input className="input" maxLength={120} value={form.name} onChange={e => setForm(value => ({ ...value, name: e.target.value }))} required /></label>
          {!isTrainerPage && <label className="stack small">{t('Type')}<select className="input" value={form.type} onChange={e => setForm(value => ({ ...value, type: e.target.value }))}><option value="GYM">{t('Gym')}</option><option value="TRAINER_BUSINESS">{t('Independent Trainer')}</option></select></label>}
          <label className="stack small">{t('Slug')}<input className="input" maxLength={80} pattern="[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?" value={form.slug} onChange={e => setForm(value => ({ ...value, slug: e.target.value }))} required /></label>
          <label className="stack small">{t('First owner e-mail')}<input className="input" type="email" autoComplete="email" maxLength={254} value={form.ownerEmail} onChange={e => setForm(value => ({ ...value, ownerEmail: e.target.value }))} required /></label>
          <label className="row" style={{ gap: 8, justifyContent: 'flex-start' }}><input type="checkbox" checked={form.sendEmail} onChange={e => setForm(value => ({ ...value, sendEmail: e.target.checked }))} />{t('Send invitation e-mail')}</label>
          <Button type="submit" variant="primary" disabled={busy}>{isTrainerPage ? t('Create workspace and invite trainer') : t('Create organization and owner invitation')}</Button>
        </form>}
      </section>
      <section className="saas-directory">
        <div className="saas-admin-filters">
          <label className="stack small">{t('Search')}<input className="input" type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>
          {!isTrainerPage && <label className="stack small">{t('Type')}<select className="input" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}><option value="ALL">{t('All')}</option><option value="GYM">{t('Gym')}</option><option value="TRAINER_BUSINESS">{t('Independent Trainer')}</option></select></label>}
          <label className="stack small">{t('Status')}<select className="input" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="ALL">{t('All')}</option><option value="ACTIVE">{t('ACTIVE')}</option><option value="SUSPENDED">{t('SUSPENDED')}</option></select></label>
        </div>
        {!directoryRows.length ? <div className="card small muted">{query ? t('No organizations match your search.') : isTrainerPage ? t('No independent trainers yet. Invite the first trainer to create their workspace.') : t('No gyms yet. Create a gym and invite its first owner.')}</div> : directoryRows.map(row => <button className="card saas-org-row" key={row.id} onClick={() => nav(`/platform/organizations/${row.id}`)}>
          <span className="saas-org-copy"><b>{row.name}</b><span className="small muted">{typeLabel(row.type)} · {row.slug}</span><span className="small muted">{row.owners?.map(owner => owner.displayName || owner.email || t('Owner invitation pending')).join(', ') || t('Owner invitation pending')}</span></span>
          <span className="saas-org-meta"><span className="tag">{t(row.status)}</span><span className="small dim">{t('{0} client(s)', row.counts?.clients || 0)}</span><Icon name="chevronRight" /></span>
        </button>)}
      </section>
    </>}

    {!loading && !error && organization && <>
      <section className="saas-admin-stats">
        {[[t('Status'), t(organization.status)], [t('Trainers'), organization.counts?.trainers], [t('Clients'), organization.counts?.clients], [t('Pending invitations'), organization.counts?.pendingInvitations]].map(([label, value]) => <div className="card" key={label}><div className="small muted">{label}</div><strong>{value ?? '—'}</strong></div>)}
      </section>
      <section className="card">
        <div className="lbl2">{t('Organization details')}</div>
        <div className="saas-detail-grid small"><span>{t('Type')}</span><b>{typeLabel(organization.type)}</b><span>{t('Slug')}</span><b>{organization.slug}</b><span>{t('Created')}</span><b>{dateText(organization.createdAt)}</b></div>
        <div className="lbl2" style={{ marginTop: 18 }}>{t('Owners')}</div>
        {organization.owners?.length ? organization.owners.map(owner => <div className="saas-owner" key={owner.userId}><b>{owner.displayName || t('Unnamed')}</b><span className="small muted">{owner.email || t('No verified e-mail')}</span></div>) : <div className="small muted" style={{ marginTop: 8 }}>{t('No owner has accepted the invitation yet.')}</div>}
      </section>
      <section className="card">
        <div className="lbl2">{t('Owner invitations')}</div>
        {organization.invitations?.filter(row => row.role === 'OWNER').map(row => <div className="saas-invitation" key={row.id}>
          <div><b>{row.email || t('Owner')}</b><div className="small muted">{t(invitationStatus(row))} · {t('E-mail: {0}', row.deliveryStatus || 'NOT_SENT')} · {t('Expires {0}', dateText(row.expiresAt))}</div></div>
          {row.createdByPlatformAdmin && ['PENDING', 'EXPIRED'].includes(invitationStatus(row)) && <div className="row" style={{ gap: 6 }}><Button size="sm" variant="ghost" disabled={busy} onClick={() => resendInvitation(organization, row)}>{t('Resend')}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => revokeInvitation(organization, row)}>{t('Revoke')}</Button></div>}
        </div>)}
        {!organization.invitations?.some(row => row.role === 'OWNER') && <div className="small muted" style={{ marginTop: 8 }}>{t('No owner invitations yet.')}</div>}
      </section>
      {organization.type === 'TRAINER_BUSINESS' && <Button variant="tinted" onClick={() => nav(`/trainer/clients?workspace=${organization.id}`)}>{t('Open trainer workspace')}</Button>}
      <div className="card small muted">{t('Platform administration shows organization membership and invitation summaries. People management and client workout access still require organization permissions.')}</div>
    </>}

    {!loading && !error && organizationId && !organization && <div className="card small muted">{t('Organization not found.')}</div>}
  </main>
}
