import { weekKey } from './format.js'
import { addDays } from './programs.js'
import { workoutVolume } from './history.js'
import { loadOf } from './muscles.js'
import { isHardSet } from './effort.js'
import { isWarmupRow } from './workout-model.js'

const round = value => Math.round(value * 10) / 10

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
