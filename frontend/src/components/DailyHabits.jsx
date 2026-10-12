import { useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { Button, Row, TextArea, TextField } from './ui.jsx'
import Icon from './Icon.jsx'
import { fmtDate, isoOf, todayISO, uid } from '../lib/format.js'
import { DAILY_HABIT_PRESETS, dailyHabitLogId, dailyHabitName, recentLocalDays } from '../lib/daily-habits.js'
import { t } from '../lib/i18n.js'

function saveBackup() { useStore.getState().autoBackupNow() }

function setHabitActive(id, active) {
  const now = Date.now()
  useStore.getState().update(s => {
    const habit = (s.dailyHabits || []).find(item => item.id === id)
    if (habit) { habit.active = active; habit._ts = now }
  })
  saveBackup()
}

function addPreset(preset) {
  const now = Date.now()
  useStore.getState().update(s => {
    const habits = s.dailyHabits ||= []
    const existing = habits.find(item => item.id === preset.id)
    if (existing) { existing.active = true; existing._ts = now }
    else habits.push({ id: preset.id, active: true, _ts: now })
  })
  saveBackup()
}

function ManageDailyHabits({ close }) {
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const [name, setName] = useState('')
  const habits = Array.isArray(S.dailyHabits) ? S.dailyHabits : []
  const active = habits.filter(habit => habit && habit.active !== false)
  const archived = habits.filter(habit => habit && habit.active === false)
  const missingPresets = DAILY_HABIT_PRESETS.filter(preset => !habits.some(habit => habit?.id === preset.id))

  const addCustom = () => {
    const clean = name.trim().slice(0, 40)
    if (!clean) return
    const duplicate = habits.find(habit => habit?.custom && habit.name?.trim().toLowerCase() === clean.toLowerCase())
    const now = Date.now()
    update(s => {
      const list = s.dailyHabits ||= []
      const existing = list.find(habit => habit?.custom && habit.name?.trim().toLowerCase() === clean.toLowerCase())
      if (existing) { existing.active = true; existing._ts = now }
      else list.push({ id: uid(), name: clean, custom: true, active: true, _ts: now })
    })
    saveBackup()
    if (!duplicate) setName('')
  }

  return <>
    <h3>{t('Manage habits')}</h3>
    <div className="small dim" style={{ margin: '-4px 0 12px' }}>{t('Custom habit names stay as entered.')}</div>

    {!!active.length && <>
      <h4 className="sec">{t('Your habits')}</h4>
      {active.map(habit => <Row key={habit.id} title={dailyHabitName(habit)}>
        <Button size="sm" variant="ghost" onClick={() => setHabitActive(habit.id, false)}>{t('Archive')}</Button>
      </Row>)}
    </>}

    {!!archived.length && <>
      <h4 className="sec">{t('Archived')}</h4>
      <div className="small dim" style={{ marginBottom: 4 }}>{t('Past check-ins are kept.')}</div>
      {archived.map(habit => <Row key={habit.id} title={dailyHabitName(habit)}>
        <Button size="sm" variant="ghost" onClick={() => setHabitActive(habit.id, true)}>{t('Restore')}</Button>
      </Row>)}
    </>}

    {!!missingPresets.length && <>
      <h4 className="sec">{t('Quick add')}</h4>
      <div className="habit-preset-list">
        {missingPresets.map(preset => <Button key={preset.id} variant="tinted" icon="plus" onClick={() => addPreset(preset)}>
          {t(preset.label)}
        </Button>)}
      </div>
    </>}

    <h4 className="sec">{t('Add a custom habit')}</h4>
    <div className="row habit-custom-add">
      <TextField value={name} maxLength={40} placeholder={t('Name your habit')} aria-label={t('Name your habit')}
        onChange={event => setName(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addCustom() } }} />
      <Button variant="primary" disabled={!name.trim()} onClick={addCustom}>{t('Add')}</Button>
    </div>
    {!active.length && !archived.length && <div className="small dim" style={{ marginTop: 10 }}>{t('Start with a preset or add your own.')}</div>}
    <div style={{ height: 12 }} />
    <Button variant="ghost" onClick={close}>{t('Done')}</Button>
  </>
}

export function manageDailyHabitsSheet() {
  useUI.getState().openSheet(close => <ManageDailyHabits close={close} />)
}

function DailyHabitNote({ habit, log, day, close }) {
  const update = useStore(s => s.update)
  const [note, setNote] = useState(log?.note || '')
  const save = () => {
    const value = note.trim()
    const now = Date.now()
    const id = dailyHabitLogId(habit.id, day)
    update(s => {
      const entry = (s.habitLogs || []).find(item => item?.id === id)
      if (!entry) return
      if (value) entry.note = value
      else delete entry.note
      entry.t = now
    })
    saveBackup()
    close()
  }
  return <>
    <h3>{t(log?.note ? 'Edit note' : 'Add note')}</h3>
    <div className="small dim" style={{ marginBottom: 10 }}>{t('Optional: dose, duration, or temperature.')}</div>
    <TextArea value={note} maxLength={140} rows={3} aria-label={t('Add note')} onChange={event => setNote(event.target.value)} />
    <div style={{ height: 12 }} />
    <Button variant="primary" onClick={save}>{t('Save')}</Button>
    <div style={{ height: 6 }} />
    <Button variant="ghost" onClick={close}>{t('Cancel')}</Button>
  </>
}

function dailyHabitNoteSheet(habit, log, day) {
  useUI.getState().openSheet(close => <DailyHabitNote habit={habit} log={log} day={day} close={close} />)
}

function toggleHabit(habit, done, day) {
  const id = dailyHabitLogId(habit.id, day)
  const now = Date.now()
  useStore.getState().update(s => {
    const logs = s.habitLogs ||= []
    const existing = logs.find(log => log?.id === id)
    if (existing) { existing.done = !done; existing.t = now }
    else logs.push({ id, habitId: habit.id, d: day, done: true, t: now })
  })
  saveBackup()
}

export function DailyHabitsCard({ S }) {
  const habits = (S.dailyHabits || []).filter(habit => habit && habit.active !== false)
  const today = todayISO()
  const todayLogs = new Map((S.habitLogs || []).filter(log => log?.d === today).map(log => [log.id || dailyHabitLogId(log.habitId, log.d), log]))
  const doneCount = habits.filter(habit => todayLogs.get(dailyHabitLogId(habit.id, today))?.done === true).length

  return <div className="card daily-habits-card">
    <div className="row between" style={{ marginBottom: habits.length ? 6 : 0 }}>
      <div>
        <h2 style={{ margin: 0 }}>{t('Daily habits')}</h2>
        {!!habits.length && <div className="small dim" style={{ marginTop: 3 }}>{t('{0} of {1} done today', doneCount, habits.length)}</div>}
      </div>
      <Button size="sm" variant="ghost" onClick={manageDailyHabitsSheet}>{t('Manage habits')}</Button>
    </div>
    {habits.length ? <div className="daily-habit-list">
      {habits.map(habit => {
        const log = todayLogs.get(dailyHabitLogId(habit.id, today))
        const done = log?.done === true
        const label = dailyHabitName(habit)
        return <div key={habit.id} className="daily-habit-row-wrap">
          <button type="button" className="daily-habit-row" aria-pressed={done} onClick={() => toggleHabit(habit, done, today)}>
            <span className="daily-habit-mark">{done && <Icon name="check" />}</span>
            <span className="daily-habit-copy"><span className="daily-habit-name">{label}</span>
              {!!log?.note && <span className="daily-habit-note-text">{log.note}</span>}
            </span>
          </button>
          {done && <button type="button" className="iconbtn daily-habit-note" aria-label={t(log.note ? 'Edit note' : 'Add note')}
            onClick={() => dailyHabitNoteSheet(habit, log, today)}><Icon name="pencil" /></button>}
        </div>
      })}
    </div> : <div className="daily-habit-empty">
      <span className="small dim">{t('Add a few things you want to remember each day.')}</span>
      <Button size="sm" variant="tinted" icon="plus" onClick={manageDailyHabitsSheet}>{t('Add check-ins')}</Button>
    </div>}
  </div>
}

export function DailyHabitsHistory({ S }) {
  const allHabits = (S.dailyHabits || []).filter(habit => habit && habit.id)
  if (!allHabits.length) return null
  const days = recentLocalDays(todayISO(), 30)
  const logs = S.habitLogs || []
  const recentIds = new Set(logs.filter(log => days.includes(log?.d)).map(log => log?.habitId))
  const habits = allHabits.filter(habit => habit.active !== false || recentIds.has(habit.id))
  return <div className="card daily-habit-history">
    <div className="row between" style={{ marginBottom: 14, alignItems: 'baseline' }}>
      <h2 style={{ margin: 0 }}>{t('Daily habits')}</h2>
      <span className="small dim">{t('Last 30 days')}</span>
    </div>
    {habits.map(habit => {
      const done = new Set(logs.filter(log => log?.habitId === habit.id && log.done === true).map(log => log.d))
      const total = days.filter(day => done.has(day)).length
      return <div className="daily-habit-history-row" key={habit.id}>
        <div className="row between" style={{ marginBottom: 7 }}>
          <b className="daily-habit-history-name">{dailyHabitName(habit)}</b>
          <span className="small dim">{t('{0} days', total)}</span>
        </div>
        <div className="daily-habit-days" role="img" aria-label={`${dailyHabitName(habit)} · ${t('{0} days', total)}`}>
          {days.map(day => {
            const checked = done.has(day)
            return <span key={day} className={'daily-habit-day' + (checked ? ' done' : '')}
              title={`${fmtDate(day, true)}: ${t(checked ? 'Done' : 'Not done')}`} />
          })}
        </div>
      </div>
    })}
  </div>
}
