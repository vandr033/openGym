import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
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
const eligibleRoles = ['OWNER', 'ADMIN', 'TRAINER']

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

export default function Organization({ trainerWorkspace = false }) {
  const nav = useNavigate()
  const { organizationId: routeOrganizationId } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const user = useStore(state => state.user)
  const config = useStore(state => state.config)
  const [organizations, setOrganizations] = useState([])
  const [organizationId, setOrganizationId] = useState(routeOrganizationId || searchParams.get('workspace') || '')
  const [currentUserId, setCurrentUserId] = useState('')
  const [orgForm, setOrgForm] = useState(false)
  const [members, setMembers] = useState([])
  const [trainers, setTrainers] = useState([])
  const [clients, setClients] = useState([])
  const [invitations, setInvitations] = useState([])
  const [expandedClient, setExpandedClient] = useState('')
  const [listQuery, setListQuery] = useState('')
  const [tab, setTab] = useState(trainerWorkspace ? 'Clients' : 'Overview')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [generated, setGenerated] = useState(null)
  const [form, setForm] = useState({ role: trainerWorkspace ? 'CLIENT' : 'TRAINER', email: '', trainerId: '', expiresInDays: '7', sendEmail: true })

  const availableOrganizations = trainerWorkspace
    ? organizations.filter(row => eligibleRoles.includes(row.membershipRole))
    : organizations
  const selected = availableOrganizations.find(row => row.id === organizationId)
  const role = selected?.membershipRole
  const canManage = ['OWNER', 'ADMIN'].includes(role)
  const isTrainer = role === 'TRAINER'
  const tabs = trainerWorkspace ? ['Clients', 'Invitations']
    : isTrainer ? ['Clients', 'Invitations']
      : canManage ? ['Overview', 'Trainers', 'Clients', 'Team', 'Invitations'] : []
  const visibleClients = trainerWorkspace ? clients.filter(row => row.relationshipId) : clients
  const visibleInvitations = trainerWorkspace
    ? invitations.filter(row => row.role === 'CLIENT' && row.trainerUserId === currentUserId)
    : invitations
  const query = listQuery.trim().toLowerCase()
  const inviteRoles = trainerWorkspace ? ['CLIENT'] : role === 'OWNER'
    ? ['OWNER', 'ADMIN', 'TRAINER', 'STAFF', 'CLIENT']
    : role === 'ADMIN' ? ['ADMIN', 'TRAINER', 'STAFF', 'CLIENT']
      : role === 'TRAINER' ? ['CLIENT'] : []

  const loadPeople = async id => {
    const org = organizations.find(row => row.id === id)
    if (!org) return
    setError(''); setMembers([]); setTrainers([]); setClients([]); setInvitations([])
    const requests = [
      ['trainers', `/api/v2/organizations/${id}/trainers`],
      ['clients', `/api/v2/organizations/${id}/clients`],
      ['invitations', `/api/v2/organizations/${id}/invitations`],
      ...(eligibleRoles.includes(org.membershipRole) && org.membershipRole !== 'TRAINER' ? [['members', `/api/v2/organizations/${id}/members`]] : [])
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
    api('/api/v2/organizations/me').then(result => {
      if (!live) return
      const rows = result.organizations || []
      setOrganizations(rows)
      setCurrentUserId(result.userId || '')
      const preferredId = routeOrganizationId || searchParams.get('workspace')
      if (preferredId) setOrganizationId(preferredId)
      else setOrganizationId((trainerWorkspace ? rows.find(row => eligibleRoles.includes(row.membershipRole)) : rows[0])?.id || '')
      setLoading(false)
    }).catch(e => {
      if (live) { setError(e.message || t('Could not load organization people.')); setLoading(false) }
    })
    return () => { live = false }
  }, [routeOrganizationId, trainerWorkspace])

  useEffect(() => { if (organizationId) loadPeople(organizationId) }, [organizationId, organizations.length])

  useEffect(() => {
    if (trainerWorkspace || isTrainer) {
      setForm(value => ({ ...value, role: 'CLIENT', trainerId: role === 'TRAINER' ? currentUserId : selected?.type === 'TRAINER_BUSINESS' ? currentUserId : '' }))
      setTab('Clients')
    } else if (canManage) {
      setForm(value => ({ ...value, role: 'TRAINER', trainerId: '' }))
      setTab(trainerWorkspace ? 'Clients' : 'Overview')
    }
    setOrgForm(false)
    setGenerated(null)
  }, [role, currentUserId, organizationId, trainers.length, trainerWorkspace])

  const chooseWorkspace = id => {
    setOrganizationId(id)
    if (trainerWorkspace) setSearchParams(id ? { workspace: id } : {})
  }

  const openInvite = invitationRole => {
    setForm(value => ({ ...value, role: invitationRole, trainerId: invitationRole === 'CLIENT' && (isTrainer || selected?.type === 'TRAINER_BUSINESS') ? currentUserId : '' }))
    setOrgForm(value => !value)
  }

  const generateInvitation = async event => {
    event.preventDefault()
    if (!selected || busy) return
    setBusy(true); setError(''); setGenerated(null)
    try {
      const result = await post(`/api/v2/organizations/${selected.id}/invitations`, {
        role: form.role, email: form.email.trim(),
        ...(form.role === 'CLIENT' ? { trainerId: isTrainer ? currentUserId : form.trainerId } : {}),
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

  const updateMember = async (member, change) => {
    setBusy(true); setError('')
    try {
      await api(`/api/v2/organizations/${selected.id}/members/${member.userId}`, { method: 'PUT', body: JSON.stringify(change) })
      await loadPeople(selected.id)
    } catch (e) { setError(e.message || t('Could not update membership.')) }
    finally { setBusy(false) }
  }

  const removeMember = member => confirmSheet({
    title: t('Remove this member?'), message: t('Their active trainer-client relationships and invitations will be revoked.'), confirmText: t('Remove'), danger: true,
    onConfirm: async () => {
      setBusy(true); setError('')
      try { await api(`/api/v2/organizations/${selected.id}/members/${member.userId}`, { method: 'DELETE' }); await loadPeople(selected.id) }
      catch (e) { setError(e.message || t('Could not remove member.')) }
      finally { setBusy(false) }
    }
  })

  const revokeRelationship = relationship => confirmSheet({
    title: t('End this trainer-client relationship?'), message: t('All permissions for this organization relationship will be revoked.'), confirmText: t('Revoke'), danger: true,
    onConfirm: async () => {
      setBusy(true); setError('')
      try { await post(`/api/v2/coaching/relationships/${relationship.id}/revoke`, {}); await loadPeople(selected.id); setExpandedClient('') }
      catch (e) { setError(e.message || t('Could not revoke relationship.')) }
      finally { setBusy(false) }
    }
  })

  const trainerRows = canManage
    ? members.filter(row => eligibleRoles.includes(row.role))
    : trainers
  const filteredTrainers = trainerRows.filter(row => `${row.displayName || ''} ${row.role} ${row.status || 'ACTIVE'}`.toLowerCase().includes(query))
  const filteredClients = visibleClients.filter(row => `${row.displayName || ''} ${row.relationshipStatus || ''}`.toLowerCase().includes(query))
  const filteredInvitations = visibleInvitations.filter(row => `${row.email || ''} ${row.role} ${row.status}`.toLowerCase().includes(query))
  const filteredMembers = members.filter(row => `${row.displayName || ''} ${row.role} ${row.status}`.toLowerCase().includes(query))
  const activeInvitations = invitations.filter(row => row.status === 'PENDING').length
  const canInviteClient = eligibleRoles.includes(role)
  const headerTitle = trainerWorkspace ? t('My clients') : t('Gym management')
  const selectedLabel = selected?.type === 'TRAINER_BUSINESS' ? `${t('Independent Trainer')} · ${selected.name}` : selected?.name

  return <main className={trainerWorkspace ? 'saas-admin trainer-workspace' : 'saas-admin gym-people'}>
    <header className="hdr">
      <button className="iconbtn" onClick={() => nav('/organization')} aria-label={t('Back to workspaces')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 10 }}><h1>{headerTitle}</h1><div className="sub">{selectedLabel || t('Select a workspace')}</div></div>
    </header>

    {trainerWorkspace && availableOrganizations.length > 1 && <label className="stack small saas-workspace-switcher">{t('Active workspace')}
      <select className="input" value={selected?.id || ''} onChange={event => chooseWorkspace(event.target.value)}>
        {availableOrganizations.map(row => <option key={row.id} value={row.id}>{row.type === 'TRAINER_BUSINESS' ? `${t('Independent Trainer')} · ${row.name}` : `${row.name} · ${t(row.membershipRole)}`}</option>)}
      </select>
    </label>}

    {generated && <InvitationSecret value={generated} onDismiss={() => setGenerated(null)} />}
    {loading && <div className="card small muted" role="status">{t('Loading…')}</div>}
    {error && <div role="alert" className="card small" style={{ color: 'var(--red)' }}>{error}</div>}

    {!loading && !availableOrganizations.length && <div className="card small muted">{trainerWorkspace ? t('No trainer workspace is available for this account.') : t('You do not have an organization role on this account.')}</div>}
    {!loading && availableOrganizations.length > 0 && !selected && <div className="card small muted">{t('This account does not have permission to manage people in this workspace.')}</div>}

    {!loading && selected && <>
      {!trainerWorkspace && availableOrganizations.length > 1 && !routeOrganizationId && <label className="stack small saas-workspace-switcher">{t('Active organization')}
        <select className="input" value={selected.id} onChange={event => chooseWorkspace(event.target.value)}>{availableOrganizations.map(row => <option key={row.id} value={row.id}>{row.name} · {t(row.membershipRole || 'CLIENT')}</option>)}</select>
      </label>}
      <section className="card">
        <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
          <div><div className="lbl2">{selectedLabel}</div>{!trainerWorkspace && <div className="small muted">{t('Your role: {0}', t(role || 'CLIENT'))}</div>}</div>
          {tabs.length > 0 && <Segmented className="seg-range" options={tabs.map(value => ({ value, label: t(value) }))} value={tabs.includes(tab) ? tab : tabs[0]} onChange={setTab} />}
        </div>
        {(tab === 'Trainers' && canManage || tab === 'Clients' && canInviteClient || tab === 'Invitations' && canInviteClient) && <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <Button size="sm" variant="primary" onClick={() => openInvite(tab === 'Trainers' ? 'TRAINER' : 'CLIENT')}>{orgForm ? t('Cancel') : tab === 'Trainers' ? t('Invite trainer') : t('Invite client')}</Button>
        </div>}
      </section>

      {orgForm && <form className="card saas-admin-form" onSubmit={generateInvitation}>
        <div className="lbl2">{t(form.role === 'CLIENT' ? 'Invite client' : 'Invite trainer')}</div>
        {!trainerWorkspace && <label className="stack small">{t('Role')}<select className="input" value={form.role} onChange={event => setForm(value => ({ ...value, role: event.target.value, trainerId: '' }))}>{inviteRoles.map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>}
        <label className="stack small">{t('E-mail address')}<input className="input" type="email" autoComplete="email" maxLength={254} value={form.email} onChange={event => setForm(value => ({ ...value, email: event.target.value }))} required /></label>
        {form.role === 'CLIENT' && <>
          <div className="small muted">{t('Choose the trainer for this client. Accepting the invitation does not grant workout permissions.')}</div>
          {isTrainer ? <div className="small">{t('Assigned trainer: {0}', user?.name || t('you'))}</div>
            : <label className="stack small">{t('Assigned trainer')}<select className="input" value={form.trainerId} onChange={event => setForm(value => ({ ...value, trainerId: event.target.value }))} required><option value="">{t('Choose a trainer')}</option>{trainers.filter(row => eligibleRoles.includes(row.role)).map(row => <option key={row.userId} value={row.userId}>{row.displayName || t('Unnamed')} · {t(row.role)}</option>)}</select></label>}
        </>}
        {!trainerWorkspace && form.role !== 'CLIENT' && <label className="stack small">{t('Invitation expires in')}<select className="input" value={form.expiresInDays} onChange={event => setForm(value => ({ ...value, expiresInDays: event.target.value }))}><option value="7">{t('7 days')}</option><option value="14">{t('14 days')}</option><option value="30">{t('30 days')}</option></select></label>}
        <label className="row" style={{ gap: 8, justifyContent: 'flex-start' }}><input type="checkbox" checked={form.sendEmail} onChange={event => setForm(value => ({ ...value, sendEmail: event.target.checked }))} />{t('Send invitation e-mail')}</label>
        <Button type="submit" variant="primary" disabled={busy || (form.role === 'CLIENT' && !isTrainer && !form.trainerId)}>{t('Generate invitation')}</Button>
      </form>}

      {tab === 'Overview' && canManage && <section className="saas-admin-stats">
        {[[t('Trainers'), trainerRows.filter(row => row.status === 'ACTIVE').length], [t('Clients'), clients.length], [t('Pending invitations'), activeInvitations]].map(([label, count]) => <div className="card" key={label}><div className="small muted">{label}</div><strong>{count}</strong></div>)}
        <div className="card"><div className="small muted">{t('Organization status')}</div><strong>{t(selected.status)}</strong></div>
      </section>}

      {tab === 'Trainers' && <section className="card"><div className="lbl2">{t('Trainers')}</div><input className="input" type="search" aria-label={t('Search people')} placeholder={t('Search people')} value={listQuery} onChange={event => setListQuery(event.target.value)} />{filteredTrainers.map(row => <div className="saas-person-row" key={row.userId}><span>{row.displayName || t('Unnamed')}</span><span className="tag">{t(row.role)} · {t(row.status || 'ACTIVE')}</span></div>)}{!filteredTrainers.length && <div className="small muted" style={{ marginTop: 8 }}>{query ? t('No people match your search.') : t('No active trainers yet.')}</div>}</section>}

      {tab === 'Clients' && <section className="card"><div className="lbl2">{t('Clients')}</div><input className="input" type="search" aria-label={t('Search people')} placeholder={t('Search people')} value={listQuery} onChange={event => setListQuery(event.target.value)} />{filteredClients.map(row => <article className="saas-client" key={row.userId}>
        <button className="saas-person-row saas-client-toggle" aria-expanded={expandedClient === row.userId} onClick={() => setExpandedClient(value => value === row.userId ? '' : row.userId)}><b>{row.displayName || t('Unnamed')}</b><span className="tag">{t(row.relationshipStatus || 'NOT_CONNECTED')}</span></button>
        {expandedClient === row.userId && <div className="saas-client-detail"><div className="small muted">{t('Relationship status')}: {t(row.relationshipStatus || 'NOT_CONNECTED')}</div>
          {role === 'TRAINER' || trainerWorkspace ? <><div className="small muted" style={{ marginTop: 6 }}>{t('Granted scopes')}</div><div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 5 }}>{(row.grantedScopes || []).map(scope => <span className="tag" key={scope}>{t(scope)}</span>)}{!row.grantedScopes?.length && <span className="small dim">{t('No permissions granted')}</span>}</div><div className="small dim" style={{ marginTop: 6 }}>{row.grantedScopes?.length ? t('Workout access is limited to these active permissions.') : t('No private workout access is granted.')}</div></> : <div className="small dim" style={{ marginTop: 6 }}>{t('Client access details are visible only to the assigned trainer and client.')}</div>}
          {role === 'OWNER' || role === 'ADMIN' ? <><div className="small muted" style={{ marginTop: 8 }}>{t('Assigned trainers')}</div>{row.relationships?.length ? row.relationships.map(relationship => <div className="saas-person-row" key={relationship.id}><span>{relationship.trainerName || t('Unnamed')} · {t(relationship.status)}{relationship.trainerName && relationship.grantedScopes ? ` · ${relationship.grantedScopes.map(t).join(', ') || t('No permissions granted')}` : ''}</span>{relationship.status === 'ACTIVE' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => revokeRelationship(relationship)}>{t('End relationship')}</Button>}</div>) : <div className="small dim">{t('No trainer relationship yet.')}</div>}</> : row.relationshipId && <div style={{ marginTop: 8 }}><Button size="sm" variant="ghost" disabled={busy} onClick={() => revokeRelationship({ id: row.relationshipId })}>{t('End relationship')}</Button></div>}
          {config?.collab_workouts && <div style={{ marginTop: 8 }}><Button size="sm" variant="tinted" onClick={() => nav('/collab')}>{t('Open collaborative workouts')}</Button></div>}
        </div>}
      </article>)}{!filteredClients.length && <div className="small muted" style={{ marginTop: 8 }}>{query ? t('No people match your search.') : !visibleClients.length ? t('No active clients yet.') : t('No people match your search.')}</div>}</section>}

      {tab === 'Team' && canManage && <section className="card"><div className="lbl2">{t('Team')}</div><input className="input" type="search" aria-label={t('Search people')} placeholder={t('Search people')} value={listQuery} onChange={event => setListQuery(event.target.value)} />{filteredMembers.map(row => <div className="saas-team-row" key={row.userId}>
        <div className="saas-team-name"><b>{row.displayName || t('Unnamed')}</b><span className="small muted">{t(row.role)} · {t(row.status)}</span></div>
        {row.role !== 'OWNER' && <div className="row saas-team-actions">
          {role === 'ADMIN' && row.role === 'ADMIN' ? <span className="tag">{t(row.role)}</span> : <select aria-label={t('Role for {0}', row.displayName || t('member'))} className="input saas-team-select" value={row.role} disabled={busy} onChange={event => updateMember(row, { role: event.target.value })}>
            {['ADMIN', 'TRAINER', 'STAFF'].filter(value => role === 'OWNER' || value !== 'ADMIN').map(value => <option value={value} key={value}>{t(value)}</option>)}
          </select>}
          <Button size="sm" variant="ghost" disabled={busy || role === 'ADMIN' && row.role === 'ADMIN'} onClick={() => updateMember(row, { status: row.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' })}>{t(row.status === 'ACTIVE' ? 'Suspend' : 'Reactivate')}</Button>
          <Button size="sm" variant="ghost" className="dim" disabled={busy || role === 'ADMIN' && row.role === 'ADMIN'} onClick={() => removeMember(row)}>{t('Remove')}</Button>
        </div>}
      </div>)}{!filteredMembers.length && <div className="small muted" style={{ marginTop: 8 }}>{query ? t('No people match your search.') : t('No team members yet.')}</div>}</section>}

      {tab === 'Invitations' && <section className="card"><div className="lbl2">{t('Invitations')}</div><input className="input" type="search" aria-label={t('Search invitations')} placeholder={t('Search invitations')} value={listQuery} onChange={event => setListQuery(event.target.value)} />{filteredInvitations.map(row => <div className="saas-invitation" key={row.id}>
        <div><div>{row.email || t('Existing account')}</div><div className="small muted">{t(row.role)} · {t(row.status)} · {t('Expires {0}', dateText(row.expiresAt))}</div><div className="small dim">{t('E-mail: {0}', row.deliveryStatus)}</div></div>
        {['PENDING', 'EXPIRED'].includes(row.status) && row.canManage && <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}><Button size="sm" variant="ghost" disabled={busy} onClick={() => resendInvitation(row)}>{t('Resend')}</Button><Button size="sm" variant="ghost" className="dim" disabled={busy} onClick={() => revokeInvitation(row)}>{t('Revoke')}</Button></div>}
      </div>)}{!filteredInvitations.length && <div className="small muted" style={{ marginTop: 8 }}>{query ? t('No invitations match your search.') : trainerWorkspace ? t('No pending client invitations.') : t('No invitations yet.')}</div>}</section>}
    </>}
  </main>
}
