import { isoOf } from '../format.js'

/** @typedef {{ date: string, steps?: number, activeEnergyKcal?: number, basalEnergyKcal?: number, totalEnergyKcal?: number, exerciseMinutes?: number, moveMinutes?: number, standMinutes?: number, flightsClimbed?: number, distanceWalkingRunningMeters?: number, distanceCyclingMeters?: number, distanceSwimmingMeters?: number, dietaryWaterMl?: number, bodyWeightKg?: number, restingHeartRateBpm?: number, walkingHeartRateBpm?: number, vo2MaxMlPerKgMin?: number, walkingSpeedMetersPerSecond?: number, hrvSdnnMs?: number, heartRateBpm?: number, sleep?: { totalMinutes: number, inBedMinutes: number, awakeMinutes: number, coreMinutes: number, deepMinutes: number, remMinutes: number, startAt?: string, endAt?: string } }} DailyHealthSummary */
/** @typedef {{ externalId: string, source: 'apple-health', workoutType: string, startAt: string, endAt: string, durationSeconds: number, activeEnergyKcal?: number, distanceMeters?: number, averageHeartRateBpm?: number, maxHeartRateBpm?: number }} HealthWorkout */

const dayOf = value => isoOf(new Date(value))
const round = n => Math.round(n * 10) / 10
const latest = samples => samples.reduce((best, s) => !best || s.endAt > best.endAt ? s : best, null)

function sleepSessions(samples) {
  const sorted = [...new Map(samples.map((s, i) => [s.id ?? i, s])).values()]
    .filter(s => new Date(s.endAt) > new Date(s.startAt))
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
  const sessions = []
  for (const sample of sorted) {
    const start = +new Date(sample.startAt), end = +new Date(sample.endAt)
    const session = sessions.at(-1)
    // ponytail: sessions within three hours merge; split by a source's session ID if naps abutting night sleep matter later.
    if (session && start <= session.end + 3 * 3600000) {
      session.end = Math.max(session.end, end)
      session.samples.push(sample)
    } else sessions.push({ end, samples: [sample] })
  }
  return sessions
}

function sleepTotals(samples) {
  const times = [...new Set(samples.flatMap(s => [+new Date(s.startAt), +new Date(s.endAt)]))].sort((a, b) => a - b)
  const total = { totalMinutes: 0, inBedMinutes: 0, awakeMinutes: 0, coreMinutes: 0, deepMinutes: 0, remMinutes: 0 }
  for (let i = 1; i < times.length; i++) {
    const a = times[i - 1], b = times[i]
    const stages = new Set(samples.filter(s => +new Date(s.startAt) < b && +new Date(s.endAt) > a).map(s => s.stage))
    const duration = (b - a) / 60000
    if (stages.has('inBed')) total.inBedMinutes += duration
    const stage = ['deep', 'rem', 'core', 'awake', 'asleep'].find(s => stages.has(s))
    if (stage === 'deep') total.deepMinutes += duration
    if (stage === 'rem') total.remMinutes += duration
    if (stage === 'core') total.coreMinutes += duration
    if (stage === 'awake') total.awakeMinutes += duration
    if (stage && stage !== 'awake') total.totalMinutes += duration
  }
  return Object.fromEntries(Object.entries(total).map(([k, v]) => [k, round(v)]))
}

export function normalizeWorkouts(workouts = [], heart = []) {
  return [...new Map(workouts.map(w => [w.id, w])).values()].map(w => {
    const rates = heart.filter(h => h.startAt >= w.startAt && h.startAt <= w.endAt).map(h => h.value)
    return {
      externalId: w.id, source: 'apple-health', workoutType: w.workoutType,
      startAt: w.startAt, endAt: w.endAt, durationSeconds: w.durationSeconds,
      ...(w.activeEnergyKcal != null ? { activeEnergyKcal: round(w.activeEnergyKcal) } : {}),
      ...(w.distanceMeters != null ? { distanceMeters: round(w.distanceMeters) } : {}),
      ...(w.averageHeartRateBpm != null || rates.length ? { averageHeartRateBpm: round(w.averageHeartRateBpm ?? rates.reduce((a, b) => a + b, 0) / rates.length) } : {}),
      ...(w.maxHeartRateBpm != null || rates.length ? { maxHeartRateBpm: w.maxHeartRateBpm ?? Math.max(...rates) } : {}),
    }
  }).sort((a, b) => b.startAt.localeCompare(a.startAt))
}

export function normalizeHealthData(raw, dates) {
  const summaries = Object.fromEntries(dates.map(date => [date, { date }]))
  for (const stat of raw.stats || []) {
    const row = summaries[stat.date]
    if (row && Number.isFinite(stat.value)) row[stat.type] = round(stat.value)
  }
  for (const [type, field] of [['bodyMass', 'bodyWeightKg'], ['restingHeartRate', 'restingHeartRateBpm'], ['walkingHeartRate', 'walkingHeartRateBpm'], ['vo2Max', 'vo2MaxMlPerKgMin'], ['walkingSpeed', 'walkingSpeedMetersPerSecond'], ['heartRateVariabilitySDNN', 'hrvSdnnMs'], ['heartRate', 'heartRateBpm']]) {
    for (const date of dates) {
      const sample = latest((raw.samples || []).filter(s => s.type === type && dayOf(s.endAt) === date))
      if (sample) summaries[date][field] = round(sample.value)
    }
  }
  for (const row of Object.values(summaries)) {
    if (row.activeEnergyKcal != null && row.basalEnergyKcal != null) row.totalEnergyKcal = round(row.activeEnergyKcal + row.basalEnergyKcal)
  }
  for (const session of sleepSessions(raw.sleep || [])) {
    const date = dayOf(session.end)
    if (!summaries[date]) continue
    const totals = sleepTotals(session.samples)
    const current = summaries[date].sleep || {}
    summaries[date].sleep = {
      ...Object.fromEntries(Object.keys(totals).map(k => [k, round((current[k] || 0) + totals[k])])),
      startAt: new Date(Math.min(current.startAt ? Date.parse(current.startAt) : Infinity, ...session.samples.map(s => Date.parse(s.startAt)))).toISOString(),
      endAt: new Date(Math.max(current.endAt ? Date.parse(current.endAt) : 0, session.end)).toISOString(),
    }
  }
  return dates.map(date => summaries[date])
}
