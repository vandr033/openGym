import { todayISO } from '../format.js'
import { MOBILE, readJsonFile, writeJsonFile } from '../mobile.js'
import { healthKitBridge } from './iosHealthKitBridge.js'
import { normalizeHealthData, normalizeWorkouts } from './healthNormalization.js'

const CACHE_FILE = 'opengym-health-cache.json'
const localDay = date => new Date(`${date}T00:00:00`)
const dateKey = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
const validDate = date => /^\d{4}-\d{2}-\d{2}$/.test(date) && dateKey(localDay(date)) === date
const addDays = (date, days) => { const day = localDay(date); day.setDate(day.getDate() + days); return dateKey(day) }
const range = (from, to) => {
  if (!validDate(from) || !validDate(to) || from > to) throw new Error('Invalid health date range')
  const dates = []
  for (let day = localDay(from); dateKey(day) <= to; day.setDate(day.getDate() + 1)) dates.push(dateKey(day))
  return dates
}
const bounds = (from, to) => {
  const start = localDay(from); start.setDate(start.getDate() - 1)
  const end = localDay(to); end.setDate(end.getDate() + 1)
  return { from: start.toISOString(), to: end.toISOString() }
}
const unavailable = () => { throw new Error('Health integration unavailable on this platform.') }
const targetKey = target => target?.server && target?.uid ? `${target.server}|${target.uid}` : null

export async function healthAvailability() {
  const bridge = await healthKitBridge()
  return bridge ? (await bridge.availability()).available : false
}

export async function requestHealthAccess() {
  const bridge = await healthKitBridge()
  if (!bridge || !(await bridge.availability()).available) unavailable()
  await bridge.requestAccess()
  const cache = await readHealthCache()
  await writeJsonFile(CACHE_FILE, { ...cache, requested: true })
}

export async function readHealthCache() {
  const cache = await readJsonFile(CACHE_FILE)
  return cache?.version === 1 ? cache : { version: 1, requested: false, summaries: {}, workouts: [], lastSync: null }
}

export async function readHealthView() {
  if (MOBILE) return readHealthCache()
  const { api } = await import('../api.js')
  const data = await api('/api/health-data')
  return { requested: true, remote: true, summaries: Object.fromEntries((data.daily || []).map(day => [day.date, day])), workouts: data.workouts || [] }
}

export const healthSyncEnabled = (cache, target) => !!targetKey(target) && cache?.syncTarget === targetKey(target)

export async function setHealthSyncEnabled(enabled, target) {
  const key = enabled && targetKey(target)
  if (enabled && !key) throw new Error('Pair this phone before enabling health sync.')
  const cache = await readHealthCache()
  await writeJsonFile(CACHE_FILE, { ...cache, syncTarget: key || null, syncCursor: null, serverSyncAt: null })
  if ((await readHealthCache()).syncTarget !== (key || null)) throw new Error('Could not save the Apple Health sync setting. Try again.')
}

export async function refreshHealthRange(from, to) {
  const dates = range(from, to)
  const bridge = await healthKitBridge()
  if (!bridge || !(await bridge.availability()).available) unavailable()
  const raw = await bridge.getData(bounds(from, to))
  const summaries = normalizeHealthData(raw, dates)
  const workouts = normalizeWorkouts(raw.workouts, (raw.samples || []).filter(s => s.type === 'heartRate'))
    .filter(w => dateKey(new Date(w.startAt)) >= from && dateKey(new Date(w.startAt)) <= to)
  const cache = await readHealthCache()
  const outside = (cache.workouts || []).filter(w => dateKey(new Date(w.startAt)) < from || dateKey(new Date(w.startAt)) > to)
  await writeJsonFile(CACHE_FILE, {
    ...cache, summaries: { ...cache.summaries, ...Object.fromEntries(summaries.map(s => [s.date, s])) },
    workouts: [...workouts, ...outside], lastSync: new Date().toISOString(), lastReadFrom: from, lastReadTo: to,
  })
  return { summaries, workouts }
}

export const getHealthSummaries = async (from, to) => (await refreshHealthRange(from, to)).summaries
export const getHealthSummaryForDate = async date => (await getHealthSummaries(date, date))[0]
export const getTodayHealthSummary = () => getHealthSummaryForDate(todayISO())
export const getRecentHealthWorkouts = async (from, to) => (await refreshHealthRange(from, to)).workouts

export function healthSyncRange(cache, today = todayISO()) {
  const cursor = cache?.syncCursor && cache.syncCursor <= today && validDate(cache.syncCursor) ? cache.syncCursor : null
  const from = cursor ? addDays(cursor, -2) : addDays(today, -29)
  return { from, to: addDays(from, 29) < today ? addDays(from, 29) : today }
}

let active = null
let activeTarget = null
let lastSuccess = 0
export async function syncHealthToServer(target, { force = false, isCurrent = () => true } = {}) {
  const key = targetKey(target)
  if (!key) return false
  if (active) {
    if (activeTarget === key) return active
    await active.catch(() => {})
  }
  if (!force && Date.now() - lastSuccess < 15 * 60000) return false
  activeTarget = key
  active = (async () => {
    let cache = await readHealthCache()
    if (!healthSyncEnabled(cache, target) || !cache.requested || !isCurrent()) return false
    const today = todayISO()
    do {
      const { from, to } = healthSyncRange(cache, today)
      const fresh = cache.lastReadFrom <= from && cache.lastReadTo >= to && Date.now() - Date.parse(cache.lastSync) < 60000
      const { summaries, workouts } = fresh
        ? { summaries: range(from, to).map(date => cache.summaries[date] || { date }), workouts: (cache.workouts || []).filter(w => dateKey(new Date(w.startAt)) >= from && dateKey(new Date(w.startAt)) <= to) }
        : await refreshHealthRange(from, to)
      cache = await readHealthCache()
      if (!healthSyncEnabled(cache, target) || !isCurrent()) return false
      const daily = summaries.filter(s => Object.keys(s).some(k => k !== 'date')).map(s => ({ ...s, source: 'apple-health' }))
      const { api } = await import('../api.js')
      const result = await api('/api/health-data', { method: 'PUT', body: JSON.stringify({ daily, workouts }) })
      if (result.ok !== true) throw new Error('Health sync was not confirmed by the server.')
      cache = await readHealthCache()
      if (!healthSyncEnabled(cache, target) || !isCurrent()) return false
      cache = { ...cache, syncCursor: to, serverSyncAt: new Date().toISOString() }
      await writeJsonFile(CACHE_FILE, cache)
    } while (cache.syncCursor < today)
    lastSuccess = Date.now()
    return true
  })().finally(() => { active = null; activeTarget = null })
  return active
}
