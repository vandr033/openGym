import { afterEach, describe, expect, it } from 'vitest'
import de from '../locales/de.js'
import { dailyHabitName, dailyHabitLogId, recentLocalDays } from './daily-habits.js'
import { _setLangState } from './i18n-core.js'

afterEach(() => _setLangState('en', null, null, null))

describe('daily habits', () => {
  it('translates preset names when the selected language changes and preserves custom names', () => {
    _setLangState('en', null, null, null)
    expect(dailyHabitName({ id: 'creatine' })).toBe('Creatine')
    expect(dailyHabitName({ id: 'user-1', name: 'Stretching' })).toBe('Stretching')
    _setLangState('de', de, null, null)
    expect(dailyHabitName({ id: 'creatine' })).toBe('Kreatin')
    expect(dailyHabitName({ id: 'user-1', name: 'Stretching' })).toBe('Stretching')
  })

  it('uses one stable check-in key per habit and local date', () => {
    expect(dailyHabitLogId('sauna', '2026-10-11')).toBe('sauna|2026-10-11')
    expect(recentLocalDays('2026-10-12', 3)).toEqual(['2026-10-10', '2026-10-11', '2026-10-12'])
    expect(recentLocalDays('not-a-date', 3)).toEqual([])
  })
})
