import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { useStore } from '../store/useStore.js'
import { Button } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'

export default function OrganizationHome() {
  const nav = useNavigate()
  const config = useStore(state => state.config)
  const [organizations, setOrganizations] = useState([])
  const [platformAdmin, setPlatformAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    Promise.allSettled([api('/api/v2/organizations/me'), api('/api/v2/platform/me')]).then(([mine, platform]) => {
      if (!live) return
      if (mine.status === 'fulfilled') setOrganizations(mine.value.organizations || [])
      else setError(mine.reason?.message || t('Could not load workspaces.'))
      setPlatformAdmin(platform.status === 'fulfilled' && platform.value.platformAdmin === true)
      setLoading(false)
    })
    return () => { live = false }
  }, [])

  const openWorkspace = row => nav(row.type === 'TRAINER_BUSINESS' || row.membershipRole === 'TRAINER'
    ? `/trainer/clients?workspace=${row.id}`
    : `/organizations/${row.id}/people`)
  const workspaces = organizations.filter(row => ['OWNER', 'ADMIN', 'TRAINER'].includes(row.membershipRole))
  const clients = organizations.filter(row => row.enrolledAsClient)

  return <main className="saas-admin workspace-home">
    <header className="hdr"><button className="iconbtn" onClick={() => nav('/home')} aria-label={t('Home')}><Icon name="chevronLeft" /></button><div style={{ flex: 1, marginInlineStart: 10 }}><h1>{t('Workspaces')}</h1><div className="sub">{t('Choose where you want to manage people or clients.')}</div></div></header>
    {loading && <div className="card small muted" role="status">{t('Loading…')}</div>}
    {error && <div className="card small" role="alert" style={{ color: 'var(--red)' }}>{error}</div>}
    {!loading && platformAdmin && <button className="card saas-admin-link" onClick={() => nav('/platform')}><span><b>{t('Platform Administration')}</b><span className="small muted">{t('Manage gyms and independent trainers.')}</span></span><Icon name="chevronRight" /></button>}
    {!loading && !!workspaces.length && <section className="saas-directory">
      <div className="lbl2">{t('Your workspaces')}</div>
      {workspaces.map(row => <button className="card saas-org-row" key={row.id} onClick={() => openWorkspace(row)}>
        <span className="saas-org-copy"><b>{row.type === 'TRAINER_BUSINESS' ? `${t('Independent Trainer')} · ${row.name}` : row.name}</b><span className="small muted">{t('Your role: {0}', t(row.membershipRole))}</span></span><Icon name="chevronRight" />
      </button>)}
    </section>}
    {!loading && !!clients.length && config?.collab_workouts && <section className="card">
      <div className="lbl2">{t('My coaching')}</div>
      <div className="small muted" style={{ margin: '5px 0 10px' }}>{t('Open your collaborative workout space.')}</div>
      <Button variant="tinted" onClick={() => nav('/collab')}>{t('Open collaborative workouts')}</Button>
    </section>}
    {!loading && !platformAdmin && !workspaces.length && !clients.length && <div className="card small muted">{t('You do not have an organization workspace yet.')}</div>}
  </main>
}
