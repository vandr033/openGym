import { isoOf, weekKey } from '../format.js'
import { addDays } from '../programs.js'
import { workoutVolume } from '../history.js'
import { loadOf } from '../muscles.js'
import { isHardSet } from '../effort.js'
import { isWarmupRow } from '../workout-model.js'

const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
const round = value => value == null ? null : Math.round(value * 10) / 10
const at = (day, field) => field === 'sleepMinutes' ? day.sleep?.totalMinutes : day[field]

// Baselines use prior calendar days, not the current reading being compared with them.
export function metricBaseline(summaries, date, field) {
  const values = days => Object.values(summaries || {}).filter(day => day.date < date && day.date >= addDays(date, -days))
    .map(day => at(day, field)).filter(Number.isFinite)
  const seven = values(7), thirty = values(30), today = at(summaries?.[date] || {}, field)
  const delta = average => today == null || average == null ? null : round(today - average)
  return { today: today ?? null, avg7: round(mean(seven)), avg30: round(mean(thirty)), count7: seven.length, count30: thirty.length,
    delta7: delta(mean(seven)), delta30: delta(mean(thirty)) }
}

export function recoveryMessages(summaries, date) {
  const hrv = metricBaseline(summaries, date, 'hrvSdnnMs')
  const heart = metricBaseline(summaries, date, 'restingHeartRateBpm')
  const sleep = metricBaseline(summaries, date, 'sleepMinutes')
  const messages = []
  if (hrv.count7 >= 3 && hrv.today != null && hrv.avg7 > 0) {
    const change = (hrv.today - hrv.avg7) / hrv.avg7
    messages.push(change > .05 ? 'HRV is above your recent baseline.' : change < -.05 ? 'HRV is below your recent baseline.' : 'HRV is close to your recent baseline.')
  }
  if (heart.count7 >= 3 && heart.today != null) messages.push(heart.delta7 > 3 ? 'Resting heart rate is above your recent baseline.' : heart.delta7 < -3 ? 'Resting heart rate is below your recent baseline.' : 'Resting heart rate is close to your recent baseline.')
  if (sleep.count7 >= 3 && sleep.today != null) messages.push(sleep.delta7 > 30 ? 'Sleep duration was above your recent average.' : sleep.delta7 < -30 ? 'Sleep duration was below your recent average.' : 'Sleep duration was close to your recent average.')
  return messages
}

export function dailyTimeline(date, summary = {}, workouts = [], healthWorkouts = []) {
  const events = []
  const add = (time, title, detail) => events.push({ time: time || null, title, detail })
  if (summary.sleep?.endAt) add(summary.sleep.endAt, 'Wake', `${Math.round(summary.sleep.totalMinutes || 0)} min sleep`)
  if (summary.bodyWeightKg != null) add(null, 'Bodyweight', `${summary.bodyWeightKg} kg`)
  for (const workout of workouts.filter(w => w.d === date)) {
    const health = workout.appleHealth
    const duration = health?.durationSeconds ?? (Number.isFinite(workout.end - workout.start) ? (workout.end - workout.start) / 1000 : null)
    add(Number.isFinite(workout.start) ? new Date(workout.start).toISOString() : health?.startAt,
      workout.name || 'Training', [duration > 0 ? `${Math.round(duration / 60)} min` : null, health?.averageHeartRateBpm != null ? `Avg HR ${health.averageHeartRateBpm} bpm` : null, health?.activeEnergyKcal != null ? `${health.activeEnergyKcal} active kcal` : null].filter(Boolean).join(' · '))
  }
  const linked = new Set(workouts.map(w => w.appleHealth?.externalId).filter(Boolean))
  for (const workout of healthWorkouts.filter(w => w.startAt && isoOf(new Date(w.startAt)) === date && !linked.has(w.externalId)))
    add(workout.startAt, workout.workoutType?.replace(/([a-z])([A-Z])/g, '$1 $2') || 'Apple Health workout', `${Math.round(workout.durationSeconds / 60)} min`)
  if (summary.steps != null) add(null, 'Steps', summary.steps.toLocaleString())
  return events.sort((a, b) => (a.time == null) - (b.time == null) || String(a.time).localeCompare(String(b.time)))
}

export function trainingLoad(workouts = [], today, weekStart) {
  const weeks = Array.from({ length: 4 }, (_, i) => ({ start: weekKey(addDays(today, (i - 3) * 7), weekStart), workingSets: 0, hardSets: 0, ratedSets: 0, volumeLoad: 0, muscles: {} }))
  for (const workout of workouts) {
    const week = weeks.find(row => row.start === weekKey(workout.d, weekStart))
    if (!week) continue
    const items = []
    for (const entry of workout.entries || []) {
      const sets = (entry.sets || []).filter(set => set.done && !isWarmupRow(set) && Number(set.r) > 0)
      if (!sets.length) continue
      week.workingSets += sets.length
      week.ratedSets += sets.filter(set => set.rir != null || set.rpe != null).length
      week.hardSets += sets.filter(isHardSet).length
      items.push({ id: entry.id, ex: entry.muscleSnapshot || entry.exercise || entry, sets: sets.length })
    }
    const muscles = loadOf(items)
    for (const [muscle, sets] of Object.entries(muscles)) week.muscles[muscle] = round((week.muscles[muscle] || 0) + sets)
    week.volumeLoad += workoutVolume(workout)
  }
  return weeks
}
