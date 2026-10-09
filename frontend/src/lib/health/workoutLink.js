import { sameWorkout } from '../workout-date.js'
import { stampWorkout } from '../sync-merge.js'

const stamp = x => new Date(x).getTime()

export function candidateHealthWorkouts(workout, healthWorkouts = [], openGymWorkouts = []) {
  const start = workout?.start, end = workout?.end
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return []
  const used = new Set(openGymWorkouts.filter(w => !sameWorkout(w, workout)).map(w => w.appleHealth?.externalId).filter(Boolean))
  return healthWorkouts.filter(h => {
    if (!h?.externalId || used.has(h.externalId) || !h.workoutType) return false
    const a = stamp(h.startAt), b = stamp(h.endAt), duration = b - a
    const overlap = Math.min(end, b) - Math.max(start, a)
    return Number.isFinite(duration) && duration > 0 && Math.abs(start - a) <= 90 * 60000 &&
      overlap >= Math.min(end - start, duration) / 2 && duration / (end - start) >= 0.5 && duration / (end - start) <= 2
  }).sort((a, b) => {
    const rank = h => /strength|training/i.test(h.workoutType) ? 1 : 0
    return rank(b) - rank(a) || Math.abs(start - stamp(a.startAt)) - Math.abs(start - stamp(b.startAt))
  })
}

export function linkHealthWorkout(state, workout, healthWorkout) {
  const record = state.workouts.find(w => sameWorkout(w, workout))
  if (!record || !healthWorkout?.externalId) throw new Error('Workout unavailable')
  if (state.workouts.some(w => !sameWorkout(w, record) && w.appleHealth?.externalId === healthWorkout.externalId)) throw new Error('Apple Health workout is already linked')
  const { externalId, workoutType, startAt, endAt, durationSeconds, activeEnergyKcal, averageHeartRateBpm, maxHeartRateBpm } = healthWorkout
  record.appleHealth = { externalId, workoutType, startAt, endAt, durationSeconds,
    ...(activeEnergyKcal != null ? { activeEnergyKcal } : {}),
    ...(averageHeartRateBpm != null ? { averageHeartRateBpm } : {}),
    ...(maxHeartRateBpm != null ? { maxHeartRateBpm } : {}) }
  stampWorkout(record)
  return record.appleHealth
}

export function unlinkHealthWorkout(state, workout) {
  const record = state.workouts.find(w => sameWorkout(w, workout))
  if (!record?.appleHealth) return false
  delete record.appleHealth
  stampWorkout(record)
  return true
}
