import { describe, expect, it } from 'vitest'
import { buildDeloadRoutine } from './deload.js'

describe('generated deload routines', () => {
  it('copies a routine, scales sets and load, and excludes the copy from progression', () => {
    const source = { id: 'r1', name: 'Upper A', ex: [{ id: '0025', sets: 4, reps: 8, weight: 100, inc: 2.5 }] }
    const result = buildDeloadRoutine({ unit: 'kg' }, source, { id: 'r2' })
    expect(result).toMatchObject({
      id: 'r2', name: 'Upper A · Deload', excludeFromProgression: true,
      ex: [{ id: '0025', sets: 2, reps: 8, weight: 85, inc: 2.5 }],
    })
    expect(source.ex[0]).toMatchObject({ sets: 4, weight: 100 })
  })

  it('respects exercise weight steps and leaves unweighted prescriptions alone', () => {
    const source = { id: 'r1', name: 'Mixed', ex: [
      { id: '0025', sets: 3, reps: 8, weight: 60, inc: 5 },
      { id: '0007', mode: 'time', sets: 2, sec: 30, weight: 0 },
    ] }
    const result = buildDeloadRoutine({ unit: 'kg' }, source, { loadMultiplier: 0.85, setMultiplier: 0.5 })
    expect(result.ex[0].weight).toBe(50)
    expect(result.ex[0].sets).toBe(2)
    expect(result.ex[1]).toMatchObject({ sets: 1, sec: 30, weight: 0 })
  })
})
