import { describe, expect, it } from 'vitest'
import { dailyTimeline, metricBaseline, recoveryMessages, trainingLoad } from './recoveryContext.js'

const date = '2026-10-08'
const summaries = {
  '2026-10-01': { date: '2026-10-01', sleep: { totalMinutes: 480 }, hrvSdnnMs: 50, restingHeartRateBpm: 50 },
  '2026-10-03': { date: '2026-10-03', sleep: { totalMinutes: 460 }, hrvSdnnMs: 52, restingHeartRateBpm: 51 },
  '2026-10-07': { date: '2026-10-07', sleep: { totalMinutes: 470 }, hrvSdnnMs: 48, restingHeartRateBpm: 49 },
  [date]: { date, sleep: { totalMinutes: 420, endAt: '2026-10-08T06:30:00Z' }, hrvSdnnMs: 58, restingHeartRateBpm: 50, steps: 9000, bodyWeightKg: 80 },
}

describe('recovery context', () => {
  it('uses only available prior calendar days for rolling averages and deltas', () => {
    expect(metricBaseline(summaries, date, 'hrvSdnnMs')).toEqual({ today: 58, avg7: 50, avg30: 50, count7: 3, count30: 3, delta7: 8, delta30: 8 })
    expect(metricBaseline(summaries, date, 'steps')).toMatchObject({ today: 9000, avg7: null, avg30: null, count30: 0, delta30: null })
    expect(metricBaseline(summaries, '2026-10-09', 'sleepMinutes')).toMatchObject({ today: null, avg7: 450, count7: 3 })
  })

  it('gives deterministic, cautious descriptions only with enough comparison data', () => {
    expect(recoveryMessages(summaries, date)).toEqual([
      'HRV is above your recent baseline.',
      'Resting heart rate is close to your recent baseline.',
      'Sleep duration was below your recent average.',
    ])
    expect(recoveryMessages({ [date]: summaries[date] }, date)).toEqual([])
  })

  it('sorts timed events, keeps aggregate readings untimed, and avoids a duplicate linked Health workout', () => {
    const health = { externalId: 'hk-1', startAt: '2026-10-08T12:00:00Z', workoutType: 'traditionalStrengthTraining', durationSeconds: 3600 }
    const gym = { d: date, name: 'Upper A', start: Date.parse(health.startAt), end: Date.parse('2026-10-08T13:00:00Z'), appleHealth: { ...health, averageHeartRateBpm: 128 } }
    expect(dailyTimeline(date, summaries[date], [gym], [health]).map(event => event.title)).toEqual(['Wake', 'Upper A', 'Bodyweight', 'Steps'])
    expect(dailyTimeline(date, summaries[date], [gym], [health])[1].detail).toContain('Avg HR 128 bpm')
  })

  it('groups completed lifting sets, rated hard sets, volume load and muscles by week', () => {
    const entry = { id: 'custom', exercise: { muscleWeights: { chest: 1 } }, sets: [
      { done: true, w: 50, r: 10, rir: 2 }, { done: true, w: 50, r: 10 }, { done: true, w: 20, r: 10, warmup: true },
    ] }
    const weeks = trainingLoad([{ d: '2026-10-01', entries: [entry] }, { d: date, entries: [entry] }], date)
    expect(weeks.at(-1)).toMatchObject({ workingSets: 2, hardSets: 1, ratedSets: 1, volumeLoad: 1000, muscles: { chest: 2 } })
    expect(weeks.at(-2)).toMatchObject({ workingSets: 2, volumeLoad: 1000 })
    expect(weeks.slice(0, 2).every(week => week.workingSets === 0)).toBe(true)
  })
})
