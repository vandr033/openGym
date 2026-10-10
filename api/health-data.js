import fs from 'node:fs'
import path from 'node:path'

const dailyFields = ['steps', 'activeEnergyKcal', 'basalEnergyKcal', 'totalEnergyKcal', 'exerciseMinutes', 'moveMinutes', 'standMinutes', 'flightsClimbed', 'distanceWalkingRunningMeters', 'distanceCyclingMeters', 'distanceSwimmingMeters', 'dietaryWaterMl', 'bodyWeightKg', 'restingHeartRateBpm', 'walkingHeartRateBpm', 'vo2MaxMlPerKgMin', 'walkingSpeedMetersPerSecond', 'hrvSdnnMs', 'heartRateBpm']
const workoutFields = ['activeEnergyKcal', 'distanceMeters', 'averageHeartRateBpm', 'maxHeartRateBpm']
const sleepFields = ['totalMinutes', 'inBedMinutes', 'awakeMinutes', 'coreMinutes', 'deepMinutes', 'remMinutes']
const object = x => !!x && typeof x === 'object' && !Array.isArray(x)
const dateOK = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(x + 'T12:00:00Z')) && new Date(x + 'T12:00:00Z').toISOString().slice(0, 10) === x
const timeOK = x => typeof x === 'string' && !Number.isNaN(Date.parse(x)) && x.length <= 40
const numberOK = (x, max) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= max
const dailyMax = key => key === 'steps' ? 1000000
  : key.endsWith('Meters') ? 100000000
    : key === 'dietaryWaterMl' ? 100000
      : key === 'flightsClimbed' ? 10000
        : key === 'vo2MaxMlPerKgMin' ? 150
          : key === 'walkingSpeedMetersPerSecond' ? 20
            : key.endsWith('HeartRateBpm') ? 300 : 100000
const only = (row, fields) => Object.keys(row).every(k => fields.includes(k))
const copyNumbers = (row, fields) => Object.fromEntries(fields.filter(k => row[k] != null).map(k => [k, row[k]]))

function dailyOf(row) {
  if (!object(row) || !only(row, ['date', 'source', 'importedAt', 'sleep', ...dailyFields]) || !dateOK(row.date) || row.source !== 'apple-health') return null
  if (dailyFields.some(k => row[k] != null && !numberOK(row[k], dailyMax(k)))) return null
  let sleep
  if (row.sleep != null) {
    if (!object(row.sleep) || !only(row.sleep, [...sleepFields, 'startAt', 'endAt']) || sleepFields.some(k => row.sleep[k] != null && !numberOK(row.sleep[k], 1440)) ||
      (row.sleep.startAt != null && !timeOK(row.sleep.startAt)) || (row.sleep.endAt != null && !timeOK(row.sleep.endAt)) ||
      (row.sleep.startAt && row.sleep.endAt && Date.parse(row.sleep.endAt) <= Date.parse(row.sleep.startAt))) return null
    sleep = { ...copyNumbers(row.sleep, sleepFields), ...(row.sleep.startAt ? { startAt: row.sleep.startAt } : {}), ...(row.sleep.endAt ? { endAt: row.sleep.endAt } : {}) }
  }
  return { date: row.date, source: 'apple-health', ...copyNumbers(row, dailyFields), ...(sleep ? { sleep } : {}) }
}

function workoutOf(row) {
  if (!object(row) || !only(row, ['externalId', 'source', 'workoutType', 'startAt', 'endAt', 'durationSeconds', 'importedAt', ...workoutFields]) || row.source !== 'apple-health') return null
  if (typeof row.externalId !== 'string' || !/^[0-9A-Za-z-]{1,128}$/.test(row.externalId) || typeof row.workoutType !== 'string' || !/^[0-9A-Za-z ._-]{1,80}$/.test(row.workoutType)) return null
  if (!timeOK(row.startAt) || !timeOK(row.endAt) || Date.parse(row.endAt) <= Date.parse(row.startAt) || !numberOK(row.durationSeconds, 86400)) return null
  if (workoutFields.some(k => row[k] != null && !numberOK(row[k], k === 'distanceMeters' ? 1000000 : k.endsWith('HeartRateBpm') ? 300 : 100000))) return null
  return { externalId: row.externalId, source: 'apple-health', workoutType: row.workoutType, startAt: row.startAt, endAt: row.endAt, durationSeconds: row.durationSeconds, ...copyNumbers(row, workoutFields) }
}

export const validHealthLink = row => object(row) && !('source' in row) && !('importedAt' in row) && !!workoutOf({ ...row, source: 'apple-health' })

export function createHealthDataStore(dataDir) {
  const file = uid => path.join(dataDir, 'health-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json')
  const empty = () => ({ daily: [], workouts: [] })
  const read = uid => {
    try {
      const saved = JSON.parse(fs.readFileSync(file(uid), 'utf8'))
      if (!Array.isArray(saved.daily) || !Array.isArray(saved.workouts)) throw new Error('invalid health data file')
      return saved
    } catch (e) { if (e.code === 'ENOENT') return empty(); throw e }
  }
  const upsert = (uid, input) => {
    if (!object(input) || !only(input, ['daily', 'workouts']) || !Array.isArray(input.daily) || !Array.isArray(input.workouts) || input.daily.length > 40 || input.workouts.length > 500) return null
    const daily = input.daily.map(dailyOf), workouts = input.workouts.map(workoutOf)
    if (daily.includes(null) || workouts.includes(null)) return null
    const current = read(uid)
    const merge = (old, fresh, key, partial = false) => {
      const rows = new Map(old.map(row => [key(row), row]))
      for (const row of fresh) {
        const prior = rows.get(key(row))
        // ponytail: missing HealthKit values may mean revoked read access; preserve them until an explicit deletion protocol exists.
        const next = partial && prior ? { ...prior, ...row, ...(row.sleep ? { sleep: { ...prior.sleep, ...row.sleep } } : {}) } : row
        const priorValues = prior && Object.fromEntries(Object.entries(prior).filter(([k]) => k !== 'importedAt'))
        const nextValues = Object.fromEntries(Object.entries(next).filter(([k]) => k !== 'importedAt'))
        rows.set(key(row), JSON.stringify(priorValues) === JSON.stringify(nextValues) ? prior : { ...nextValues, importedAt: new Date().toISOString() })
      }
      return [...rows.values()]
    }
    const next = { daily: merge(current.daily, daily, d => d.source + ':' + d.date, true), workouts: merge(current.workouts, workouts, w => w.externalId) }
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      const dest = file(uid), tmp = dest + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 })
      fs.renameSync(tmp, dest)
    }
    return next
  }
  const remove = uid => { try { fs.unlinkSync(file(uid)) } catch (e) { if (e.code !== 'ENOENT') throw e } }
  return { read, upsert, remove }
}
