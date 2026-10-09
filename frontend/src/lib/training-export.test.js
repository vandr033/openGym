import { describe, expect, it } from 'vitest'
import {
  buildExerciseHistoryExport, buildTrainingExport, exerciseHistoryPrompt, TRAINING_AI_PROMPT,
  trainingExportCSV, trainingPeriod, TRAINING_EXPORT_FORMAT,
} from './training-export.js'

const period = { from: '2026-09-01', to: '2026-10-01' }
const workout = (date, over = {}) => ({
  id: date, d: date, start: Date.parse(date + 'T18:00:00Z'), end: Date.parse(date + 'T19:00:00Z'),
  routineIds: ['upper'], name: 'Upper', entries: [{
    id: '0025', target: { sets: 2, repsMin: 8, reps: 12, weight: 60, prog: 'double', inc: 2.5 },
    note: 'exercise setup', sets: [
      { w: 60, r: 12, done: true, rir: 2, note: 'grip felt unstable' },
      { w: 60, r: 12, done: true, rpe: 8, discomfort: { severity: 'mild', note: 'wrist' } },
    ]
  }], ...over,
})
const state = () => ({
  unit: 'kg',
  routines: [{ id: 'upper', name: 'Upper A' }],
  bodyweight: [{ d: '2026-09-12', w: 80.1 }, { d: '2026-10-02', w: 79.8 }],
  workouts: [
    workout('2026-08-31'),
    workout('2026-09-12', {
      note: 'good session', prs: [{ id: '0025', type: 'weight', value: 60 }],
      readiness: { energy: 4, sleep: 3, soreness: 2 },
      program: { programId: 'block', programName: 'Hypertrophy Block', phaseId: 'base', phaseName: 'Base', deload: false },
    }),
    workout('2026-09-30', { deload: true }),
    workout('2026-10-02'),
  ]
})

describe('AI training export', () => {
  it('calculates date presets and respects custom ranges', () => {
    expect(trainingPeriod('7d', '2026-10-06')).toEqual({ from: '2026-09-30', to: '2026-10-06' })
    expect(trainingPeriod('14d', '2026-10-06').from).toBe('2026-09-23')
    expect(trainingPeriod('4w', '2026-10-06').from).toBe('2026-09-09')
    expect(trainingPeriod('6w', '2026-10-06').from).toBe('2026-08-26')
    expect(trainingPeriod('custom', '2026-10-06', '2026-09-03', '2026-09-18'))
      .toEqual({ from: '2026-09-03', to: '2026-09-18' })
  })

  it('exports only the chosen period with workouts, bodyweight and full useful context', () => {
    const data = buildTrainingExport(state(), period)
    expect(data.format).toBe(TRAINING_EXPORT_FORMAT)
    expect(data.workouts).toHaveLength(2)
    expect(data.bodyWeight).toEqual([{ date: '2026-09-12', weight: 80.1, unit: 'kg' }])
    expect(data.workouts[0]).toMatchObject({
      date: '2026-09-12', routine: 'Upper', program: { programName: 'Hypertrophy Block', phaseName: 'Base' },
      sessionNote: 'good session', durationSeconds: 3600, readiness: { energy: 4, sleep: 3, soreness: 2 },
      prs: [{ id: '0025', type: 'weight', value: 60 }],
    })
    expect(data.workouts[0].exercises[0]).toMatchObject({
      target: { sets: 2, repRange: { min: 8, max: 12 }, weight: 60 },
      progression: { type: 'double', step: 2.5 },
      exerciseNote: 'exercise setup',
      sets: [
        { number: 1, weight: 60, reps: 12, rir: 2, note: 'grip felt unstable', completed: true },
        { number: 2, rpe: 8, discomfort: { severity: 'mild', note: 'wrist' } },
      ],
    })
    expect(data.workouts[1].deload).toBe(true)
  })

  it('exports a useful set-level CSV and the AI prompt avoids medical diagnoses', () => {
    const csv = trainingExportCSV(buildTrainingExport(state(), period))
    expect(csv).toContain('setNote')
    expect(csv).toContain('grip felt unstable')
    expect(csv).toContain('Hypertrophy Block')
    expect(csv).toContain('bodyweight,2026-09-12')
    expect(TRAINING_AI_PROMPT).toContain('Do not make medical diagnoses.')
  })

  it('includes compact daily health and linked workout context only within the selected period', () => {
    const S = state()
    S.workouts[1].appleHealth = { durationSeconds: 3500, averageHeartRateBpm: 128, activeEnergyKcal: 400, externalId: 'hk-1' }
    const health = { summaries: {
      '2026-08-31': { date: '2026-08-31', steps: 100 },
      '2026-09-12': { date: '2026-09-12', sleep: { totalMinutes: 450, deepMinutes: 60, remMinutes: 90 }, hrvSdnnMs: 55, steps: 8000 },
    } }
    const data = buildTrainingExport(S, period, health)
    expect(data.dailyHealth).toEqual([{ date: '2026-09-12', health: { sleepMinutes: 450, deepSleepMinutes: 60, remSleepMinutes: 90, hrvSdnnMs: 55, steps: 8000 } }])
    expect(data.workouts[0].appleHealth).toEqual({ durationSeconds: 3500, averageHeartRateBpm: 128, activeEnergyKcal: 400 })
    expect(TRAINING_AI_PROMPT).toContain('Do not imply causation')
  })

  it('exports the latest 6–10 sessions for one exercise with progression decisions', () => {
    const S = state()
    S.workouts = Array.from({ length: 12 }, (_, index) => {
      const date = '2026-09-' + String(index + 1).padStart(2, '0')
      return workout(date, { entries: [workout(date).entries[0]] })
    })
    const data = buildExerciseHistoryExport(S, '0025', { limit: 8 })
    expect(data.sessions).toHaveLength(8)
    expect(data.sessions[0].date).toBe('2026-09-05')
    expect(data.sessions.at(-1).progressionDecision).toContain('reset target to 8 reps')
    expect(exerciseHistoryPrompt(data)).toContain('Training history:')
  })
})
