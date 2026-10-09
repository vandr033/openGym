import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Section, Row, Button, Switch } from '../components/ui.jsx'
import LineChart from '../components/LineChart.jsx'
import Icon from '../components/Icon.jsx'
import { todayISO } from '../lib/format.js'
import { addDays } from '../lib/programs.js'
import { MOBILE } from '../lib/mobile.js'
import { useStore } from '../store/useStore.js'
import { dailyTimeline, metricBaseline, recoveryMessages } from '../lib/health/recoveryContext.js'
import { healthAvailability, readHealthCache, readHealthView, requestHealthAccess, refreshHealthRange, healthSyncEnabled, setHealthSyncEnabled, syncHealthToServer } from '../lib/health/healthService.js'

const duration = minutes => minutes == null ? '—' : `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m`
const number = (value, unit = '') => value == null ? '—' : `${Math.round(value * 10) / 10}${unit}`
const clock = value => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'
const points = (summaries, field) => Object.values(summaries || {}).filter(day => (field === 'sleepMinutes' ? day.sleep?.totalMinutes : day[field]) != null)
  .sort((a, b) => a.date.localeCompare(b.date)).map(day => ({ t: new Date(`${day.date}T12:00:00`).getTime(), d: day.date, y: field === 'sleepMinutes' ? day.sleep.totalMinutes : day[field] }))

function Metric({ title, field, summaries, date, unit, format = number, chart = false }) {
  const baseline = metricBaseline(summaries, date, field)
  const delta = baseline.delta30 ?? baseline.delta7
  const span = baseline.count30 ? 30 : 7
  const count = baseline.count30 || baseline.count7
  return <div className="recovery-metric">
    <div className="small dim">{title}</div>
    <div className="recovery-value">{format(baseline.today, unit)}</div>
    <div className="small dim">{count ? `${count < span ? 'Limited data · ' : ''}${delta > 0 ? '+' : delta < 0 ? '−' : ''}${field === 'sleepMinutes' ? `${Math.abs(delta)} min` : format(Math.abs(delta), unit)} vs ${span}-day baseline · ${count} day${count === 1 ? '' : 's'}` : 'No baseline yet'}</div>
    <div className="small dim" style={{ marginTop: 4 }}>7-day avg: {format(baseline.avg7, unit)} ({baseline.count7}d) · 30-day avg: {format(baseline.avg30, unit)} ({baseline.count30}d)</div>
    {chart && <div className="chart"><LineChart points={points(summaries, field)} h={112} unit={unit.trim()} /></div>}
  </div>
}

export default function HealthPreview() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const user = useStore(s => s.user)
  const server = useStore(s => s.sync.server)
  const target = user && server ? { uid: user.id, server } : null
  const [available, setAvailable] = useState(null)
  const [cache, setCache] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const date = todayISO()
  useEffect(() => {
    let live = true
    Promise.all([healthAvailability(), user || MOBILE ? readHealthView() : Promise.resolve({ requested: false, summaries: {}, workouts: [] })]).then(([ok, saved]) => {
      if (live) { setAvailable(ok); setCache(saved) }
    }).catch(e => { if (live) { setAvailable(false); setError(e.message) } })
    return () => { live = false }
  }, [user?.id, server])
  const refresh = async () => {
    setBusy(true); setError('')
    try {
      if (available) {
        await refreshHealthRange(addDays(date, -29), date)
        setCache(await readHealthCache())
        if (healthSyncEnabled(await readHealthCache(), target)) {
          try { await syncHealthToServer(target, { force: true, isCurrent: () => useStore.getState().user?.id === target.uid && useStore.getState().sync.server === target.server }) }
          catch (e) { setError(`Saved on this device; server sync is pending: ${e.message}`) }
          setCache(await readHealthCache())
        }
      } else setCache(await readHealthView())
    } catch (e) { setError(e.message) }
    setBusy(false)
  }
  const connect = async () => {
    setBusy(true); setError('')
    try { await requestHealthAccess(); await refresh() }
    catch (e) { setError(e.message); setBusy(false) }
  }
  const changeSync = async enabled => {
    setBusy(true); setError('')
    try {
      await setHealthSyncEnabled(enabled, target)
      setCache(await readHealthCache())
      if (enabled) {
        try { await syncHealthToServer(target, { force: true, isCurrent: () => useStore.getState().user?.id === target.uid && useStore.getState().sync.server === target.server }) }
        catch (e) { setError(`Saved on this device; server sync is pending: ${e.message}`) }
        setCache(await readHealthCache())
      }
    } catch (e) { setError(e.message) }
    setBusy(false)
  }
  const summaries = cache?.summaries || {}
  const summary = summaries[date] || {}
  const messages = recoveryMessages(summaries, date)
  const timeline = dailyTimeline(date, summary, S.workouts, cache?.workouts)
  const hasData = Object.values(summaries).some(day => Object.keys(day).some(key => !['date', 'source', 'importedAt'].includes(key)))
  return <div className="narrow recovery-page">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/home')} aria-label="Home"><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 10 }}><h1>Recovery</h1><div className="sub">Health context for training</div></div>
    </div>
    {!available && !cache?.remote && available !== null && <Section title="Apple Health"><Row title="Health reading is available on iPhone." /></Section>}
    {cache?.remote && !hasData && <Section title="Health data"><Row title="No synced health data yet" subtitle="Connect Apple Health and enable server sync on your iPhone." /></Section>}
    {available && !cache?.requested && <Section title="Connect Apple Health" footer="You choose which health data openGym may read. It stays on this device unless you enable server sync.">
      <Row title="Read sleep, activity, heart metrics, body weight and workouts" />
      <div style={{ padding: 16 }}><Button variant="primary" disabled={busy} onClick={connect}>Connect Apple Health</Button></div>
    </Section>}
    {hasData && <>
      <div className="card">
        <h2>Recovery context · Today</h2>
        {messages.length ? messages.map(message => <div className="recovery-message" key={message}>{message}</div>) : <div className="small dim">More recent readings are needed for a comparison. Daily values remain available below.</div>}
        <div className="small dim" style={{ marginTop: 10 }}>Based on recent averages. These readings do not change your planned workout.</div>
      </div>
      <div className="card"><h2>Sleep</h2>
        <Metric title="Total sleep" field="sleepMinutes" summaries={summaries} date={date} unit=" min" format={duration} chart />
        <div className="recovery-grid">
          {[['In bed', 'inBedMinutes'], ['Awake', 'awakeMinutes'], ['Core', 'coreMinutes'], ['Deep', 'deepMinutes'], ['REM', 'remMinutes']].map(([label, key]) =>
            <div key={key}><span className="small dim">{label}</span><strong>{duration(summary.sleep?.[key])}</strong></div>)}
          <div><span className="small dim">Sleep window</span><strong>{clock(summary.sleep?.startAt)}–{clock(summary.sleep?.endAt)}</strong></div>
        </div>
      </div>
      <div className="card"><h2>Cardiovascular recovery</h2>
        <Metric title="HRV (SDNN)" field="hrvSdnnMs" summaries={summaries} date={date} unit=" ms" chart />
        <Metric title="Resting heart rate" field="restingHeartRateBpm" summaries={summaries} date={date} unit=" bpm" chart />
      </div>
      <div className="card"><h2>Activity</h2>
        <div className="recovery-grid">
          <div><span className="small dim">Steps</span><strong>{summary.steps?.toLocaleString() ?? '—'}</strong></div>
          <div><span className="small dim">Active energy</span><strong>{number(summary.activeEnergyKcal, ' kcal')}</strong></div>
          <div><span className="small dim">Exercise</span><strong>{number(summary.exerciseMinutes, ' min')}</strong></div>
        </div>
        <div className="chart"><LineChart points={points(summaries, 'steps')} h={112} unit="steps" /></div>
      </div>
      <div className="card"><h2>Body</h2><Metric title="Bodyweight trend" field="bodyWeightKg" summaries={summaries} date={date} unit=" kg" chart /></div>
      <div className="card"><h2>Today’s timeline</h2>
        {timeline.length ? timeline.map((event, index) => <div className="recovery-event" key={index}>
          <time>{event.time ? clock(event.time) : 'Today'}</time><div><strong>{event.title}</strong>{event.detail && <div className="small dim">{event.detail}</div>}</div>
        </div>) : <div className="small dim">No health or training events today.</div>}
      </div>
    </>}
    {available && cache?.requested && <Section title="Apple Health sync" footer={target ? 'Off by default. Turning it off stops future uploads; existing server data remains.' : 'Pair this phone with your server to enable health sync.'}>
      <Row title="Sync health data to my server" subtitle={cache.serverSyncAt ? `Last uploaded: ${new Date(cache.serverSyncAt).toLocaleString()}` : 'Health data stays on this device'}>
        <Switch checked={healthSyncEnabled(cache, target)} disabled={!target || busy} onChange={changeSync} />
      </Row>
    </Section>}
    {(available && cache?.requested || cache?.remote) && <div style={{ padding: '0 0 32px' }}><Button disabled={busy} onClick={refresh}>Refresh health data</Button></div>}
    {error && <p role="alert" className="sect-f">{error}</p>}
  </div>
}
