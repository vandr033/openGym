import { describe, expect, it } from 'vitest'
import { candidateHealthWorkouts, linkHealthWorkout, unlinkHealthWorkout } from './workoutLink.js'

const start = Date.parse('2026-10-08T12:42:00Z')
const gym = { id: 'gym-1', d: '2026-10-08', start, end: start + 72 * 60000, entries: [] }
const health = { externalId: 'HK-1', workoutType: 'traditionalStrengthTraining', startAt: '2026-10-08T12:39:00Z', endAt: '2026-10-08T13:57:00Z', durationSeconds: 4680, activeEnergyKcal: 631, averageHeartRateBpm: 128, maxHeartRateBpm: 164 }

describe('Apple Health workout linking', () => {
  it('finds overlapping sessions, rejects distant ones and excludes links already used', () => {
    const distant = { ...health, externalId: 'HK-2', startAt: '2026-10-08T18:00:00Z', endAt: '2026-10-08T19:00:00Z' }
    expect(candidateHealthWorkouts(gym, [distant, health], [gym])).toEqual([health])
    expect(candidateHealthWorkouts(gym, [health], [gym, { id: 'gym-2', appleHealth: { externalId: 'HK-1' } }])).toEqual([])
  })

  it('persists summary values, blocks duplicate links, and permits linking after unlink', () => {
    const other = { ...gym, id: 'gym-2', start: start + 5000 }
    const state = { workouts: [gym, other] }
    expect(linkHealthWorkout(state, gym, health)).toMatchObject({ externalId: 'HK-1', durationSeconds: 4680, activeEnergyKcal: 631, averageHeartRateBpm: 128, maxHeartRateBpm: 164 })
    expect(() => linkHealthWorkout(state, other, health)).toThrow('already linked')
    expect(unlinkHealthWorkout(state, gym)).toBe(true)
    expect(linkHealthWorkout(state, other, health).externalId).toBe('HK-1')
    expect(unlinkHealthWorkout(state, gym)).toBe(false)
  })
})
