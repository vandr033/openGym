import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { cacheCollabSession, cachedCollabSession, clearCollabSession, clientActiveSessionPath, readClientActiveSession } from '../lib/collab-sessions.js'
import { allExercises } from '../lib/exercises.js'
import { useStore } from '../store/useStore.js'
import { Button, TextField } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import { t } from '../lib/i18n.js'

const operationId = () => crypto.randomUUID()
const sessionPath = id => `/api/v2/workout-sessions/${encodeURIComponent(id)}`
const operationPath = id => `${sessionPath(id)}/operations`
const decimalInput = value => value === '' ? null : value
const integerInput = value => value === '' ? null : Number(value)
const displaySet = row => [row.weightKg == null ? null : `${row.weightKg} kg`, row.reps == null ? null : `${row.reps} reps`, row.durationSeconds == null ? null : `${row.durationSeconds} sec`].filter(Boolean).join(' × ') || t('Empty set')

export default function CollabWorkout() {
  const nav = useNavigate()
  const S = useStore(state => state.S)
  const user = useStore(state => state.user)
  const [session, setSession] = useState(null)
  const [organizations, setOrganizations] = useState([])
  const [organizationId, setOrganizationId] = useState('')
  const [online, setOnline] = useState(false)
  const [loading, setLoading] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(null)
  const [exerciseQuery, setExerciseQuery] = useState('')
  const [newSet, setNewSet] = useState({ weightKg: '', reps: '' })
  const [editing, setEditing] = useState(null)

  const refresh = useCallback(async () => {
    if (!user?.id) return null
    try {
      const result = await readClientActiveSession(user.id)
      setSession(result.session)
      cacheCollabSession(user.id, result.session)
      setOnline(true)
      setUnavailable(false)
      setError('')
      return result.session
    } catch (e) {
      setOnline(false)
      if ([401, 403, 404].includes(e.status)) {
        setSession(null)
        clearCollabSession(user.id)
        setUnavailable(true)
        setError(t('Collaborative workouts are not available for this account.'))
      } else setError(e.message || t('Could not reach the workout server.'))
      return null
    } finally { setLoading(false) }
  }, [user?.id])

  useEffect(() => {
    let live = true
    setSession(cachedCollabSession(user?.id))
    setOnline(false)
    setConflict(null)
    refresh()
    api('/api/v2/organizations/me').then(result => {
      if (live) setOrganizations((result.organizations || []).filter(org => org.enrolledAsClient))
    }).catch(() => {})
    return () => { live = false }
  }, [refresh, user?.id])

  const catalog = useMemo(() => allExercises(S), [S])
  const matches = useMemo(() => {
    const q = exerciseQuery.trim().toLowerCase()
    if (!q) return []
    return catalog.filter(ex => `${ex.name || ''} ${ex.id || ''}`.toLowerCase().includes(q)).slice(0, 8)
  }, [catalog, exerciseQuery])

  const start = async () => {
    setError(''); setNotice('')
    try {
      const result = await api(clientActiveSessionPath(user.id).replace(/\/active$/, ''), {
        method: 'POST', body: JSON.stringify({
          operationId: operationId(), organizationId: organizationId || null,
          routineSnapshot: { name: t('Collaborative workout'), exercises: [] }
        })
      })
      setSession(result.session)
      cacheCollabSession(user.id, result.session)
      setOnline(true)
    } catch (e) {
      setError(e.message || t('Could not start the workout.'))
      if ([401, 403, 404].includes(e.status)) { clearCollabSession(user.id); setSession(null) }
    }
  }

  const handleAuthLoss = e => {
    if (![401, 403, 404].includes(e.status)) return false
    clearCollabSession(user.id)
    setSession(null)
    setConflict(null)
    setOnline(false)
    setUnavailable(true)
    setError(t('Access to this collaborative workout is no longer available.'))
    return true
  }

  const keepServer = async () => {
    setConflict(null)
    setEditing(null)
    if (conflict?.server) {
      setSession(conflict.server)
      cacheCollabSession(user.id, conflict.server.status === 'ACTIVE' ? conflict.server : null)
    } else await refresh()
  }

  const submitOperation = async (command, mine, retryFactory = null) => {
    if (!session || !online) return false
    setError('')
    try {
      await api(operationPath(session.id), { method: 'POST', body: JSON.stringify(command) })
      setConflict(null)
      await refresh()
      return true
    } catch (e) {
      if (handleAuthLoss(e)) return false
      if (e.status === 409) {
        let server = null
        try {
          server = (await api(sessionPath(session.id))).session
          setSession(server)
          cacheCollabSession(user.id, server.status === 'ACTIVE' ? server : null)
        } catch (readError) {
          if (handleAuthLoss(readError)) return false
        }
        setOnline(true)
        setConflict({ mine, server, serverRow: e.data?.current || null, code: e.data?.code,
          retry: server?.status === 'ACTIVE' && retryFactory ? () => retryFactory(server, e.data) : null })
        return false
      }
      setError(e.message || t('Could not save the workout change.'))
      setOnline(false)
      return false
    }
  }

  const submitLifecycle = async (action, version = session?.version, retryFactory = null) => {
    if (!session || !online) return false
    const targetSessionId = session.id
    try {
      const result = await api(`${sessionPath(targetSessionId)}/${action}`, {
        method: 'POST', body: JSON.stringify({ operationId: operationId(), expectedSessionVersion: version })
      })
      setConflict(null)
      setNotice(action === 'complete' ? t('Workout completed and saved to its server session record.') : t('Workout cancelled.'))
      clearCollabSession(user.id)
      await refresh()
      return result
    } catch (e) {
      if (handleAuthLoss(e)) return false
      if (e.status === 409) {
        let server = null
        try { server = (await api(sessionPath(targetSessionId))).session } catch (readError) { if (handleAuthLoss(readError)) return false }
        if (server) {
          setSession(server)
          cacheCollabSession(user.id, server.status === 'ACTIVE' ? server : null)
        }
        setConflict({ mine: { action }, server, serverRow: e.data?.current || null, code: e.data?.code,
          retry: server?.status === 'ACTIVE' ? (retryFactory ? () => retryFactory(server) : () => submitLifecycle(action, server?.version)) : null })
        return false
      }
      setError(e.message || t('Could not finish the workout.'))
      return false
    }
  }

  const addExercise = (exercise, version = session?.version) => {
    if (!session) return
    const exerciseInput = {
      exerciseId: String(exercise.id), name: exercise.name,
      snapshot: { id: exercise.id, name: exercise.name, bodyPart: exercise.bp || null, equipment: exercise.eq || null, mode: 'reps' },
      noProgression: false, sets: []
    }
    const send = version => submitOperation({ operationId: operationId(), type: 'exercise.add', expectedSessionVersion: version,
      target: {}, patch: { exercise: exerciseInput } }, { exercise: exercise.name }, server => server && addExercise(exercise, server.version))
    return send(version).then(ok => { if (ok) setExerciseQuery('') })
  }

  const addSet = exercise => {
    const patch = {
      weightKg: decimalInput(newSet.weightKg), reps: integerInput(newSet.reps), phase: 'WORK', done: false,
      details: { schemaVersion: 1, mode: 'reps' }
    }
    const command = { operationId: operationId(), type: 'set.create', target: { exerciseId: exercise.id }, patch }
    submitOperation(command, { exercise: exercise.name, set: patch })
      .then(ok => { if (ok) setNewSet({ weightKg: '', reps: '' }) })
  }

  const saveSet = (exercise, row, values, expectedVersion = row.version) => {
    const patch = { weightKg: decimalInput(values.weightKg), reps: integerInput(values.reps), done: !!values.done }
    const command = { operationId: operationId(), type: 'set.update', target: { setId: row.id }, expectedSetVersion: expectedVersion, patch }
    return submitOperation(command, { exercise: exercise.name, set: { ...values } }, (server, body) => {
      const current = body?.current || server?.exercises.flatMap(ex => ex.sets).find(set => set.id === row.id)
      if (!current) return null
      if (current.deletedAt) {
        const replacement = {
          position: row.position, phase: row.phase,
          weightKg: decimalInput(values.weightKg), reps: integerInput(values.reps), durationSeconds: row.durationSeconds,
          rir: row.rir, rpe: row.rpe, done: !!values.done, notes: row.notes,
          details: row.details?.data || {}
        }
        return submitOperation({ operationId: operationId(), type: 'set.create', target: { exerciseId: exercise.id }, patch: replacement },
          { exercise: exercise.name, set: { ...values }, note: t('This creates a new set because the server deleted the original.') })
      }
      return saveSet(exercise, current, values, current.version)
    })
  }

  const deleteSet = (row, exercise) => submitOperation({ operationId: operationId(), type: 'set.delete',
    target: { setId: row.id }, expectedSetVersion: row.version }, { exercise: exercise.name, set: displaySet(row), action: 'delete' })

  const latestExercises = session?.exercises.filter(ex => !ex.deletedAt) || []

  return <div className="narrow">
    <div className="hdr">
      <div><h1>{t('Collaborative workout')}</h1><div className="sub">{t('Server-authoritative session')}</div></div>
      <Button size="sm" variant="ghost" icon="chevronLeft" onClick={() => nav('/home')}>{t('Home')}</Button>
    </div>

    {!user && <div className="card">{t('Sign in to use collaborative workouts.')}</div>}
    {error && <div className="card" role="alert" style={{ color: 'var(--orange)' }}>{error}</div>}
    {notice && <div className="card" role="status">{notice}</div>}
    {loading && <div className="card" role="status">{t('Loading collaborative session…')}</div>}
    {!online && session && <div className="card" role="status">{t('Showing the last saved snapshot. Reconnect to edit; offline changes are not queued.')}</div>}
    {unavailable && <div className="card">{t('This server has collaborative workouts disabled.')}</div>}

    {!session && online && user && <div className="card">
      <h2>{t('Start a collaborative workout')}</h2>
      <p className="muted">{t('Your personal workout stays separate. A coach can read or log only with your current grants.')}</p>
      {organizations.length > 0 && <label className="stack small">
        {t('Coaching organization')}
        <select className="input" value={organizationId} onChange={e => setOrganizationId(e.target.value)}>
          <option value="">{t('Private workout')}</option>
          {organizations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}
        </select>
      </label>}
      <Button variant="tinted" icon="play" onClick={start}>{t('Start collaborative workout')}</Button>
    </div>}

    {session && <>
      <div className="card">
        <div className="row between"><div><div className="lbl2">{t('Session')}</div><code>{session.id}</code></div>
          <Button size="sm" variant="ghost" icon="reset" disabled={!user || loading} onClick={refresh}>{t('Refresh')}</Button></div>
        <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <span className="tag acc">{session.viewerRole === 'TRAINER' ? t('Trainer view') : t('Client view')}</span>
          <span className="tag">{session.status}</span>
          <span className="tag">{t('Version')} {session.version} · {t('Event')} {session.lastEventSeq}</span>
        </div>
        <p className="small muted">{t('This session is stored in the SaaS database and does not enter personal history or profile sync.')}</p>
      </div>

      <div className="card">
        <h2>{t('Add exercise')}</h2>
        <TextField aria-label={t('Search exercises')} placeholder={t('Search exercises')} value={exerciseQuery} disabled={!online || session.status !== 'ACTIVE'} onChange={e => setExerciseQuery(e.target.value)} />
        {!!matches.length && <div className="list" style={{ marginTop: 8 }}>
          {matches.map(ex => <div key={ex.id} className="item row between">
            <span>{ex.name}</span><Button size="sm" variant="ghost" disabled={!online || session.status !== 'ACTIVE'} onClick={() => addExercise(ex)}>{t('Add')}</Button>
          </div>)}
        </div>}
      </div>

      {latestExercises.map(exercise => <section className="card" key={exercise.id} aria-labelledby={`collab-${exercise.id}`}>
        <div className="row between"><div><h2 id={`collab-${exercise.id}`} style={{ margin: 0 }}>{exercise.name}</h2>
          <div className="small muted">{exercise.exerciseId}{exercise.noProgression ? ` · ${t('Excluded from progression')}` : ''}</div></div>
          {exercise.snapshot?.sg && <span className="tag">{t('Superset')} {exercise.snapshot.sg}</span>}
        </div>
        {exercise.sets.filter(row => !row.deletedAt).map(row => <div className="row between" key={row.id} style={{ borderTop: '1px solid var(--line)', padding: '10px 0', flexWrap: 'wrap' }}>
          {editing?.setId === row.id ? <div className="row" style={{ flex: 1, flexWrap: 'wrap' }}>
            <TextField aria-label={t('Weight in kg')} inputMode="decimal" placeholder={t('kg')} value={editing.weightKg} onChange={e => setEditing(current => ({ ...current, weightKg: e.target.value }))} />
            <TextField aria-label={t('Repetitions')} inputMode="numeric" placeholder={t('reps')} value={editing.reps} onChange={e => setEditing(current => ({ ...current, reps: e.target.value }))} />
              <Button size="sm" variant="tinted" disabled={!online} onClick={async () => {
              const ok = await saveSet(exercise, row, editing, editing.expectedVersion)
              if (ok) setEditing(null)
            }}>{t('Save')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>{t('Cancel')}</Button>
          </div> : <>
            <div><span className="tag">{row.phase === 'WARMUP' ? t('Warm-up') : t('Work')}</span> {displaySet(row)}
              {row.rir != null && <span className="small muted"> · RIR {row.rir}</span>}{row.rpe != null && <span className="small muted"> · RPE {row.rpe}</span>}
              {row.done && <span className="tag" style={{ marginLeft: 6 }}>{t('Done')}</span>}
            </div>
            <div className="row">
              <Button size="sm" variant="ghost" disabled={!online || session.status !== 'ACTIVE'} onClick={() => setEditing({ setId: row.id, expectedVersion: row.version, weightKg: row.weightKg ?? '', reps: row.reps ?? '', done: row.done })}>{t('Edit')}</Button>
              <Button size="sm" variant="ghost" disabled={!online || session.status !== 'ACTIVE'} onClick={() => saveSet(exercise, row, { weightKg: row.weightKg ?? '', reps: row.reps ?? '', done: !row.done })}>{row.done ? t('Undo') : t('Mark done')}</Button>
              <Button size="sm" variant="ghost" disabled={!online || session.status !== 'ACTIVE'} onClick={() => deleteSet(row, exercise)} aria-label={t('Delete set')}><Icon name="xmark" /></Button>
            </div>
          </>}
        </div>)}
        <div className="row" style={{ borderTop: '1px solid var(--line)', paddingTop: 10, flexWrap: 'wrap' }}>
          <TextField aria-label={t('Weight in kg')} inputMode="decimal" placeholder={t('kg')} value={newSet.weightKg} disabled={!online || session.status !== 'ACTIVE'} onChange={e => setNewSet(current => ({ ...current, weightKg: e.target.value }))} />
          <TextField aria-label={t('Repetitions')} inputMode="numeric" placeholder={t('reps')} value={newSet.reps} disabled={!online || session.status !== 'ACTIVE'} onChange={e => setNewSet(current => ({ ...current, reps: e.target.value }))} />
          <Button size="sm" variant="ghost" disabled={!online || session.status !== 'ACTIVE'} onClick={() => addSet(exercise)}>{t('Add set')}</Button>
        </div>
      </section>)}

      {session.status === 'ACTIVE' && <div className="card row between">
        <Button variant="ghost" disabled={!online} onClick={() => submitLifecycle('cancel')}>{t('Cancel workout')}</Button>
        <Button variant="tinted" icon="check" disabled={!online} onClick={() => submitLifecycle('complete')}>{t('Finish workout')}</Button>
      </div>}
    </>}

    {conflict && <div className="card" role="alert" aria-live="assertive">
      <h2>{t('This changed on the server')}</h2>
      <div className="row" style={{ alignItems: 'stretch', flexWrap: 'wrap' }}>
        <div className="grow"><div className="lbl2">{t('Your unsent edit')}</div><pre className="small">{JSON.stringify(conflict.mine, null, 2)}</pre></div>
        <div className="grow"><div className="lbl2">{t('Current server version')}</div>
          <div className="small">{t('Version')} {conflict.server?.version ?? conflict.serverRow?.version ?? '—'}</div>
          {conflict.serverRow && <pre className="small">{JSON.stringify(conflict.serverRow, null, 2)}</pre>}
          {conflict.server && <div className="small">{conflict.server.exercises.filter(ex => !ex.deletedAt).map(ex => `${ex.name}: ${ex.sets.filter(row => !row.deletedAt).length} ${t('sets')}`).join(' · ')}</div>}
        </div>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <Button size="sm" variant="ghost" onClick={keepServer}>{t('Keep server')}</Button>
        {conflict.retry && <Button size="sm" variant="tinted" onClick={async () => { const retry = conflict.retry; setConflict(null); await retry() }}>{t('Review and retry mine')}</Button>}
      </div>
    </div>}
  </div>
}
