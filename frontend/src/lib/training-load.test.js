import { describe, expect, it } from 'vitest'
import { trainingLoad } from './training-load.js'

describe('training load', () => {
  it('groups completed lifting sets, rated hard sets, volume load and muscles by week', () => {
    const date = '2026-10-08'
    const entry = { id: 'custom', exercise: { muscleWeights: { chest: 1 } }, sets: [
      { done: true, w: 50, r: 10, rir: 2 }, { done: true, w: 50, r: 10 }, { done: true, w: 20, r: 10, warmup: true },
    ] }
    const weeks = trainingLoad([{ d: '2026-10-01', entries: [entry] }, { d: date, entries: [entry] }], date)
    expect(weeks.at(-1)).toMatchObject({ workingSets: 2, hardSets: 1, ratedSets: 1, volumeLoad: 1000, muscles: { chest: 2 } })
    expect(weeks.at(-2)).toMatchObject({ workingSets: 2, volumeLoad: 1000 })
    expect(weeks.slice(0, 2).every(week => week.workingSets === 0)).toBe(true)
  })
})
