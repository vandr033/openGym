import { t } from './i18n.js'
import { isoOf } from './format.js'

// Presets are stored by stable id, never by their translated label. User-created labels stay
// exactly as entered; the app translates its own built-in names when the profile language changes.
export const DAILY_HABIT_PRESETS = [
  { id: 'creatine', label: 'Creatine' },
  { id: 'cold-plunge', label: 'Cold plunge' },
  { id: 'sauna', label: 'Sauna' },
]

export function dailyHabitName(habit) {
  const preset = DAILY_HABIT_PRESETS.find(item => item.id === habit?.id)
  return preset ? t(preset.label) : String(habit?.name || '')
}

export const dailyHabitLogId = (habitId, day) => `${habitId}|${day}`

// Noon avoids daylight-saving transitions changing the local calendar day while this window is
// being built. Dates follow the app's local-date convention, the same one used by workouts.
export function recentLocalDays(endDay, count = 30) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDay) || !Number.isInteger(count) || count < 1) return []
  const end = new Date(`${endDay}T12:00:00`)
  if (!Number.isFinite(end.getTime())) return []
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(end)
    day.setDate(end.getDate() - count + 1 + i)
    return isoOf(day)
  })
}
