import { todayISO } from '../format.js'
import { MOBILE, readJsonFile, writeJsonFile } from '../mobile.js'
import { healthKitBridge } from './iosHealthKitBridge.js'
import { normalizeHealthData, normalizeWorkouts } from './healthNormalization.js'

const CACHE_FILE = 'opengym-health-cache.json'
const log = (...args) => console.info('[HealthKit]', ...args)
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
  log('Checking native availability')
  try {
    const bridge = await healthKitBridge()
    if (!bridge) { log('No iOS HealthKit bridge on this platform'); return false }
    log('Bridge resolved; invoking native availability')
    const result = await bridge.availability()
    log('Native availability result:', result.available)
    return result.available
  } catch (error) {
    console.error('[HealthKit] Availability check failed:', error)
    throw error
  }
}

export async function requestHealthAccess() {
  log('Permission request flow started')
  try {
    const bridge = await healthKitBridge()
    if (!bridge) { log('Permission request skipped: no native bridge'); unavailable() }
    const availability = await bridge.availability()
    log('Availability before permission request:', availability.available)
    if (!availability.available) unavailable()
    log('Calling native requestAccess; iOS may not show a sheet if a choice was already made')
    await bridge.requestAccess()
    log('Native requestAccess completed; saving requested flag')
    const cache = await readHealthCache()
    await writeJsonFile(CACHE_FILE, { ...cache, requested: true })
    log('Permission request flow completed; requested flag saved')
  } catch (error) {
    console.error('[HealthKit] Permission request failed:', error)
    throw error
  }
}

export async function readHealthCache() {
  const cache = await readJsonFile(CACHE_FILE)
  if (cache?.version === 1) {
    log('Local cache loaded:', { requested: !!cache.requested, summaryDays: Object.keys(cache.summaries || {}).length, workouts: (cache.workouts || []).length })
    return cache
  }
  log('No local health cache yet; using empty first-launch state')
  return { version: 1, requested: false, summaries: {}, workouts: [], lastSync: null }
}

export async function readHealthView() {
  if (MOBILE) {
    log('Reading on-device HealthKit cache')
    return readHealthCache()
  }
  log('Reading remote health data')
  const { api } = await import('../api.js')
  const data = await api('/api/health-data')
  const result = { requested: true, remote: true, summaries: Object.fromEntries((data.daily || []).map(day => [day.date, day])), workouts: data.workouts || [] }
  log('Remote health data loaded:', { summaryDays: Object.keys(result.summaries).length, workouts: result.workouts.length })
  return result
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
  log('Refreshing HealthKit data for date range:', { from, to })
  const dates = range(from, to)
  const bridge = await healthKitBridge()
  try {
    if (!bridge) { log('Refresh stopped: no native bridge'); unavailable() }
    const availability = await bridge.availability()
    log('Availability before refresh:', availability.available)
    if (!availability.available) unavailable()
    const raw = await bridge.getData(bounds(from, to))
    log('Native data received:', { stats: raw.stats?.length || 0, samples: raw.samples?.length || 0, sleepSamples: raw.sleep?.length || 0, workouts: raw.workouts?.length || 0 })
    const summaries = normalizeHealthData(raw, dates)
    const workouts = normalizeWorkouts(raw.workouts, (raw.samples || []).filter(s => s.type === 'heartRate'))
      .filter(w => dateKey(new Date(w.startAt)) >= from && dateKey(new Date(w.startAt)) <= to)
    const cache = await readHealthCache()
    const outside = (cache.workouts || []).filter(w => dateKey(new Date(w.startAt)) < from || dateKey(new Date(w.startAt)) > to)
    await writeJsonFile(CACHE_FILE, {
      ...cache, summaries: { ...cache.summaries, ...Object.fromEntries(summaries.map(s => [s.date, s])) },
      workouts: [...workouts, ...outside], lastSync: new Date().toISOString(), lastReadFrom: from, lastReadTo: to,
    })
    log('Refresh saved:', { summaryDays: summaries.length, daysWithValues: summaries.filter(s => Object.keys(s).some(key => key !== 'date')).length, workouts: workouts.length })
    return { summaries, workouts }
  } catch (error) {
    console.error('[HealthKit] Data refresh failed:', error)
    throw error
  }
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
