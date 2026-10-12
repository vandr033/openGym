import { describe, expect, it } from 'vitest'
import { EXIDX } from './exercises.js'
import { applyRoutineImport, parseRoutineImport, ROUTINE_FORMAT, ROUTINE_TEMPLATE } from './routine-import.js'

const json = value => JSON.stringify(value)
const source = (exercise = 'Bench Press') => ({
  format: ROUTINE_FORMAT,
  name: 'AI Plan',
  schedule: [{ day: 'monday', routine: 'Upper A' }],
  routines: [{ name: 'Upper A', exercises: [{
    exercise, sets: 3, repRange: { min: 8, max: 12 }, weight: 60, weightUnit: 'kg',
    restSeconds: 120, progression: { type: 'double', step: 2.5 }, notes: 'Pause at the bottom'
  }] }]
})
const fixedId = (() => { let n = 0; return () => 'id-' + ++n })()

describe('ChatGPT-friendly routine JSON', () => {
  it('parses the published template and maps prescriptions to existing routine fields', () => {
    const parsed = parseRoutineImport(json(ROUTINE_TEMPLATE), { unit: 'kg' })
    expect(parsed.format).toBe(ROUTINE_FORMAT)
    expect(parsed.routines).toHaveLength(3)
    expect(parsed.routines[0].exercises[0].config).toMatchObject({
      sets: 3, reps: 12, repsMin: 8, weight: 30, restSec: 180, prog: 'double', inc: 2, note: '2 RIR, controlled eccentric'
    })
    expect(parsed.routines[2].deload).toBe(true)
  })

  it('converts load and progression step to the profile unit', () => {
    const parsed = parseRoutineImport(json(source()), { unit: 'lb' })
    expect(parsed.routines[0].exercises[0].config.weight).toBe(132.5)
    expect(parsed.routines[0].exercises[0].config.inc).toBe(5.5)
  })

  it('imports warm-ups, drop-sets and rest-pause into the existing exercise plan fields', () => {
    const data = source()
    data.routines[0].exercises = [
      { exercise: 'Bench Press', sets: 3, reps: 8, warmupSets: 2, intensifier: { type: 'dropset', count: 2, pct: 20 } },
      { exercise: 'Lat Pulldown', sets: 3, reps: 8, intensifier: { type: 'restpause', totalReps: 12, restSec: 15 } }
    ]
    const parsed = parseRoutineImport(data)
    expect(parsed.routines[0].exercises.map(item => item.config)).toEqual([
      { sets: 3, reps: 8, prog: 'linear', warmupSets: 2, intensifier: { type: 'dropset', count: 2, pct: 20 } },
      { sets: 3, reps: 8, prog: 'linear', intensifier: { type: 'restpause', totalReps: 12, restSec: 15 } }
    ])
    const state = { unit: 'kg', routines: [], customEx: [], week: {} }
    const choices = Object.fromEntries(parsed.routines.flatMap((routine, ri) => routine.exercises.map((item, ei) => [`${ri}:${ei}`, item.match.selectedId])))
    applyRoutineImport(state, parsed, { choices, idFactory: fixedId })
    expect(state.routines[0].ex.map(({ warmupSets, intensifier }) => ({ warmupSets, intensifier }))).toEqual([
      { warmupSets: 2, intensifier: { type: 'dropset', count: 2, pct: 20 } },
      { warmupSets: undefined, intensifier: { type: 'restpause', totalReps: 12, restSec: 15 } }
    ])
  })

  it('rejects unsupported or incompatible set options', () => {
    const data = source()
    data.routines[0].exercises[0].warmupSets = 6
    expect(() => parseRoutineImport(data)).toThrow('Warm-up set count')
    data.routines[0].exercises[0].warmupSets = 1
    data.routines[0].exercises[0].intensifier = { type: 'restpause', totalReps: 12 }
    expect(() => parseRoutineImport(data)).toThrow('do not combine')
    data.routines[0].exercises[0].warmupSets = 0
    data.routines[0].exercises[0].intensifier = { type: 'unknown' }
    expect(() => parseRoutineImport(data)).toThrow('Unsupported intensifier type')
  })

  it('rejects invalid JSON, unknown formats, and invalid schedule references', () => {
    expect(() => parseRoutineImport('{')).toThrow('valid JSON')
    expect(() => parseRoutineImport({ ...source(), format: 'wrong' })).toThrow(ROUTINE_FORMAT)
    expect(() => parseRoutineImport({ ...source(), schedule: [{ day: 'Mondayish', routine: 'Missing' }] })).toThrow('weekday')
    const badUnit = source()
    badUnit.routines[0].exercises[0].weightUnit = 'stone'
    expect(() => parseRoutineImport(badUnit)).toThrow('kg or lb')
  })

  it('distinguishes exact, safe likely, ambiguous and unmatched exercise names', () => {
    const exactName = EXIDX['0025'].n
    expect(parseRoutineImport(json(source(exactName))).routines[0].exercises[0].match.status).toBe('exact')
    expect(parseRoutineImport(json(source('Bench Press'))).routines[0].exercises[0].match.status).toBe('likely')
    expect(parseRoutineImport(json(source('Curl'))).routines[0].exercises[0].match.status).toBe('ambiguous')
    expect(parseRoutineImport(json(source('Invented Parabolic Press'))).routines[0].exercises[0].match.status).toBe('unmatched')
  })

  it('creates custom exercises only when selected and applies the imported schedule', () => {
    const parsed = parseRoutineImport(json(source('Invented Parabolic Press')))
    const s = { unit: 'kg', routines: [], customEx: [], week: {} }
    const result = applyRoutineImport(s, parsed, { choices: { '0:0': 'custom' }, idFactory: fixedId })
    expect(result.created).toHaveLength(1)
    expect(s.customEx[0]).toMatchObject({ n: 'Invented Parabolic Press', custom: true })
    expect(s.routines[0].ex[0].id).toBe(s.customEx[0].id)
    expect(s.week[1]).toEqual([s.routines[0].id])
  })

  it('rejects duplicate source routine names and never overwrites a collision by default', () => {
    expect(() => parseRoutineImport({
      format: ROUTINE_FORMAT, routines: [
        { name: 'Same', exercises: ['Bench Press'] },
        { name: ' same ', exercises: ['Squat'] }
      ]
    })).toThrow('unique')
    const parsed = parseRoutineImport(json(source()))
    const s = { unit: 'kg', routines: [{ id: 'old', name: 'Upper A', ex: [] }], customEx: [], week: { 1: ['old'] } }
    const result = applyRoutineImport(s, parsed, { collision: 'version', idFactory: fixedId })
    expect(s.routines[0]).toMatchObject({ id: 'old', name: 'Upper A' })
    expect(result.created[0].name).toBe('Upper A (Version 2)')
    expect(s.week[1]).toEqual([result.created[0].id])
  })

  it('replaces explicitly while preserving the old routine as an archived definition', () => {
    const parsed = parseRoutineImport(json(source()))
    const s = { unit: 'kg', routines: [{ id: 'old', name: 'Upper A', ex: [] }], customEx: [], week: { 1: ['old'] } }
    const result = applyRoutineImport(s, parsed, { collision: 'replace', applySchedule: false, idFactory: fixedId })
    expect(s.routines[0].name).toContain('Archived')
    expect(result.created[0].name).toBe('Upper A')
    expect(s.week[1]).toEqual([result.created[0].id])
  })
})
