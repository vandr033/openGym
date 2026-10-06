import { describe, expect, it } from 'vitest'
import { activeProgramContext, createProgram, extendPhase, pauseProgram, phaseForDate, programRoutineIds, resumeProgram, switchPhaseNow } from './programs.js'
import { effectiveRoutineIds } from './history.js'
import { buildCombinedEntries } from './session-merge.js'

const base = () => createProgram({
  id: 'block', name: 'Hypertrophy Block', startDate: '2026-10-05',
  phases: [
    { id: 'base', name: 'Base', weeks: 2, schedule: { 1: ['upper-a'] } },
    { id: 'deload', name: 'Deload', weeks: 1, deload: true, schedule: { 1: ['upper-a'] } },
    { id: 'volume', name: 'Volume', weeks: 2, schedule: { 3: ['upper-b'] } },
  ],
})
const state = program => ({
  programs: [program], activeProgramId: program.id,
  routines: [
    { id: 'upper-a', name: 'Upper A', ex: [{ id: '0025', sets: 3, reps: 8, repsMin: 6, weight: 60 }] },
    { id: 'upper-b', name: 'Upper B', ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }] },
  ],
  week: { 1: ['upper-b'] }, dayPlan: {},
})

describe('program calendar', () => {
  it('calculates phase boundaries from the start date and duration', () => {
    const program = base()
    expect(phaseForDate(program, '2026-10-18')).toMatchObject({ phase: { id: 'base' }, start: '2026-10-05', end: '2026-10-19' })
    expect(phaseForDate(program, '2026-10-19')).toMatchObject({ phase: { id: 'deload' }, start: '2026-10-19', end: '2026-10-26' })
    expect(phaseForDate(program, '2026-10-26')).toMatchObject({ phase: { id: 'volume' }, start: '2026-10-26' })
    expect(phaseForDate(program, '2026-11-09')).toBeNull()
  })

  it('uses the active phase schedule while preserving explicit date overrides', () => {
    const st = state(base())
    expect(programRoutineIds(st, '2026-10-05')).toEqual(['upper-a'])
    expect(effectiveRoutineIds(st, '2026-10-05')).toEqual(['upper-a'])
    expect(effectiveRoutineIds({ ...st, dayPlan: { '2026-10-05': 'rest' } }, '2026-10-05')).toEqual([])
    expect(effectiveRoutineIds({ ...st, dayPlan: { '2026-10-05': 'upper-b' } }, '2026-10-05')).toEqual(['upper-b'])
    expect(effectiveRoutineIds(st, '2026-10-07')).toEqual([])
  })

  it('accepts a legacy scalar routine id in a phase schedule', () => {
    const program = base()
    program.phases[0].schedule[1] = 'upper-a'
    expect(programRoutineIds(state(program), '2026-10-05')).toEqual(['upper-a'])
  })

  it('identifies a deload phase and builds its exercises outside progression', () => {
    const st = state(base())
    const context = activeProgramContext(st, '2026-10-20')
    expect(context).toMatchObject({ phase: { id: 'deload', deload: true }, deload: true })
    const built = buildCombinedEntries(st, ['upper-a'], { deload: context.deload })
    expect(built.entries[0]).toMatchObject({ noProg: true, plan: { kind: 'off' } })
  })

  it('extends the active phase and moves later phases by one week', () => {
    const extended = extendPhase(base(), 0)
    expect(extended.phases[0].weeks).toBe(3)
    expect(extended.phases[1].startsOn).toBe('2026-10-26')
    expect(phaseForDate(extended, '2026-10-25').phase.id).toBe('base')
    expect(phaseForDate(extended, '2026-10-26').phase.id).toBe('deload')
  })

  it('switches a phase now and reschedules phases after it', () => {
    const switched = switchPhaseNow(base(), 1, '2026-10-12')
    expect(phaseForDate(switched, '2026-10-12').phase.id).toBe('deload')
    expect(switched.phases[2].startsOn).toBe('2026-10-19')
  })

  it('pauses immediately and resumes by shifting the interrupted schedule', () => {
    const paused = pauseProgram(base(), '2026-10-12')
    expect(phaseForDate(paused, '2026-10-13')).toBeNull()
    const resumed = resumeProgram(paused, '2026-10-15')
    expect(resumed.pausedAt).toBeNull()
    expect(phaseForDate(resumed, '2026-10-15').phase.id).toBe('base')
    expect(phaseForDate(resumed, '2026-10-13')).toBeNull()
    expect(resumed.phases[0].startsOn).toBe('2026-10-05')
    expect(resumed.phases[1].startsOn).toBe('2026-10-22')
  })
})
