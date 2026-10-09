import { describe, expect, it } from 'vitest'
import { normalizeHealthData, normalizeWorkouts } from './healthNormalization.js'

const sample = (id, stage, startAt, endAt) => ({ id, stage, startAt, endAt })
const date = '2026-10-08'

describe('Apple Health normalization', () => {
  it('keeps partial and missing metrics absent while using merged activity statistics', () => {
    const [day] = normalizeHealthData({
      stats: [{ date, type: 'steps', value: 6842 }, { date, type: 'activeEnergyKcal', value: 352.56 }],
      samples: [{ id: 'w', type: 'bodyMass', value: 136.4, endAt: `${date}T10:00:00Z` }],
    }, [date])
    expect(day).toEqual({ date, steps: 6842, activeEnergyKcal: 352.6, bodyWeightKg: 136.4 })
  })

  it('assigns an overnight session to its waking date and does not double count overlapping sources or duplicate samples', () => {
    const sleep = [
      sample('bed', 'inBed', '2026-10-07T22:00:00', '2026-10-08T06:00:00'),
      sample('a', 'core', '2026-10-07T22:30:00', '2026-10-08T01:00:00'),
      sample('a', 'core', '2026-10-07T22:30:00', '2026-10-08T01:00:00'),
      sample('other-source', 'asleep', '2026-10-07T22:30:00', '2026-10-08T06:00:00'),
      sample('b', 'core', '2026-10-07T23:30:00', '2026-10-08T01:30:00'),
      sample('c', 'deep', '2026-10-08T01:30:00', '2026-10-08T02:30:00'),
      sample('d', 'awake', '2026-10-08T02:30:00', '2026-10-08T03:00:00'),
      sample('e', 'rem', '2026-10-08T03:00:00', '2026-10-08T04:00:00'),
      sample('f', 'asleep', '2026-10-08T04:00:00', '2026-10-08T06:00:00'),
    ]
    const [yesterday, today] = normalizeHealthData({ sleep }, ['2026-10-07', date])
    expect(yesterday.sleep).toBeUndefined()
    expect(today.sleep).toEqual({ totalMinutes: 420, inBedMinutes: 480, awakeMinutes: 30, coreMinutes: 180, deepMinutes: 60, remMinutes: 60,
      startAt: new Date('2026-10-07T22:00:00').toISOString(), endAt: new Date('2026-10-08T06:00:00').toISOString() })
  })

  it('normalizes workouts with a stable UUID and optional heart and energy fields', () => {
    const workout = { id: 'hk-1', workoutType: 'traditionalStrengthTraining', startAt: '2026-10-08T10:00:00Z', endAt: '2026-10-08T11:00:00Z', durationSeconds: 3600 }
    const heart = [{ startAt: '2026-10-08T10:15:00Z', value: 100 }, { startAt: '2026-10-08T10:45:00Z', value: 140 }]
    expect(normalizeWorkouts([workout, workout], heart)).toEqual([{
      externalId: 'hk-1', source: 'apple-health', workoutType: 'traditionalStrengthTraining',
      startAt: workout.startAt, endAt: workout.endAt, durationSeconds: 3600,
      averageHeartRateBpm: 120, maxHeartRateBpm: 140,
    }])
  })
})
