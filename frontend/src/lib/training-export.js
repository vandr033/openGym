import { exOr } from './exercises.js'
import { hasCompletedWork, isStraightWorkSet, setType } from './workout-model.js'
import { modeOf } from './history.js'
import { addDays } from './programs.js'

export const TRAINING_EXPORT_FORMAT = 'opengym-training-export-v1'
export const trainingPeriod = (preset, today, customFrom, customTo) => {
  const span = ({ '7d': 7, '14d': 14, '4w': 28, '6w': 42 })[preset]
  if (preset === 'custom') return { from: customFrom || today, to: customTo || today }
  const days = span || 28
  return { from: addDays(today, 1 - days), to: today }
}

const dateInPeriod = (date, period) => typeof date === 'string' && date >= period.from && date <= period.to
const dateTime = workout => String(workout.d || '') + 'T' + String(Math.floor((Number(workout.start) || 0) / 60000) % 1440).padStart(4, '0')
const setFields = (set, index, target) => {
  const s = set || {}
  return {
    number: index + 1,
    type: setType(s),
    weight: s.w ?? null,
    reps: s.r ?? null,
    durationSeconds: s.sec ?? null,
    durationMinutes: s.min ?? null,
    speedKmh: s.speed ?? null,
    completed: hasCompletedWork(s),
    rir: s.rir ?? null,
    rpe: s.rpe ?? null,
    note: s.note || null,
    discomfort: s.discomfort || null,
    ...(s.sides ? { sides: s.sides } : {}),
    ...(target?.repsMin != null || target?.reps != null ? {
      repRange: { min: target.repsMin ?? target.reps, max: target.reps ?? target.repsMax ?? null }
    } : {})
  }
}

const exerciseName = (state, id) => (state.customEx || []).find(ex => ex.id === id)?.n || exOr(id).n || id

function trainingExercise(state, entry) {
  const target = entry.target || {}
  const cfg = { ...target, id: entry.id }
  return {
    exerciseId: entry.id,
    exercise: exerciseName(state, entry.id),
    mode: modeOf(cfg),
    target: {
      sets: target.sets ?? null,
      repRange: target.repsMin != null || target.reps != null
        ? { min: target.repsMin ?? target.reps, max: target.reps ?? target.repsMax ?? null }
        : null,
      weight: target.weight ?? null,
      durationSeconds: target.sec ?? null,
      durationMinutes: target.min ?? null,
    },
    progression: { type: target.prog || null, step: target.inc ?? null },
    exerciseNote: entry.note || null,
    discomfort: entry.discomfort || null,
    sets: (entry.sets || []).map((set, index) => setFields(set, index, target)),
  }
}

export function buildTrainingExport(state, period) {
  const workouts = (state.workouts || [])
    .filter(workout => dateInPeriod(workout.d, period))
    .slice()
    .sort((a, b) => dateTime(a).localeCompare(dateTime(b)))
    .map(workout => ({
      date: workout.d,
      startTime: Number(workout.start) ? new Date(workout.start).toISOString() : null,
      routine: workout.name || (workout.routineIds || []).map(id => state.routines?.find(r => r.id === id)?.name).filter(Boolean).join(' + ') || null,
      routineIds: workout.routineIds || (workout.routineId ? [workout.routineId] : []),
      program: workout.program || null,
      deload: workout.deload === true || workout.program?.deload === true,
      durationSeconds: Number.isFinite(workout.end) && Number.isFinite(workout.start)
        ? Math.max(0, Math.round((workout.end - workout.start) / 1000)) : null,
      sessionNote: workout.note || null,
      readiness: workout.readiness || null,
      prs: workout.prs || [],
      exercises: (workout.entries || []).map(entry => trainingExercise(state, entry)),
    }))
  return {
    format: TRAINING_EXPORT_FORMAT,
    period: { from: period.from, to: period.to },
    unit: state.unit || 'kg',
    bodyWeight: (state.bodyweight || []).filter(item => dateInPeriod(item.d, period))
      .map(item => ({ date: item.d, weight: item.w, unit: state.unit || 'kg' })),
    workouts,
  }
}

const csvCell = value => {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
}
const CSV_COLUMNS = [
  'recordType', 'date', 'routine', 'program', 'phase', 'deload', 'exercise', 'setNumber', 'setType',
  'weight', 'reps', 'durationSeconds', 'durationMinutes', 'completed', 'rir', 'rpe', 'repMin', 'repMax',
  'targetWeight', 'progressionType', 'progressionStep', 'setNote', 'exerciseNote', 'sessionNote',
  'sessionDurationSeconds', 'prs', 'readiness', 'discomfort', 'bodyWeight', 'unit'
]

export function trainingExportCSV(data) {
  const rows = [CSV_COLUMNS]
  for (const workout of data.workouts || []) {
    for (const exercise of workout.exercises || []) {
      for (const set of exercise.sets || []) rows.push([
        'set', workout.date, workout.routine, workout.program?.programName, workout.program?.phaseName, workout.deload,
        exercise.exercise, set.number, set.type, set.weight, set.reps, set.durationSeconds, set.durationMinutes,
        set.completed, set.rir, set.rpe, set.repRange?.min, set.repRange?.max, exercise.target?.weight,
        exercise.progression?.type, exercise.progression?.step, set.note, exercise.exerciseNote, workout.sessionNote,
        workout.durationSeconds, workout.prs, workout.readiness, set.discomfort || exercise.discomfort,
        '', data.unit
      ])
    }
  }
  for (const item of data.bodyWeight || []) rows.push([
    'bodyweight', item.date, '', '', '', false, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
    '', '', '', '', '', '', '', item.weight, item.unit
  ])
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n')
}

function progressionDecision(workout, entry) {
  if (workout.deload || workout.program?.deload || entry.noProg) return 'excluded from progression'
  const target = entry.target || {}
  if (target.prog !== 'double' || target.reps == null) return null
  const straight = (entry.sets || []).filter(set => isStraightWorkSet(set))
  const expected = Math.max(1, Number(target.sets) || straight.length)
  const upper = Number(target.reps)
  const complete = straight.length >= expected && straight.every(set => set.done && Number(set.r) >= upper)
  return complete
    ? 'increase load next time; reset target to ' + (target.repsMin ?? upper) + ' reps'
    : 'hold load and continue toward ' + upper + ' reps'
}

export function buildExerciseHistoryExport(state, exerciseId, { limit = 8 } = {}) {
  const count = Math.max(6, Math.min(10, Math.round(Number(limit) || 8)))
  const sessions = (state.workouts || [])
    .filter(workout => (workout.entries || []).some(entry => entry.id === exerciseId))
    .slice()
    .sort((a, b) => dateTime(a).localeCompare(dateTime(b)))
    .slice(-count)
    .map(workout => {
      const entry = workout.entries.find(item => item.id === exerciseId)
      const exercise = trainingExercise(state, entry)
      return {
        date: workout.d,
        routine: workout.name || null,
        program: workout.program || null,
        deload: workout.deload === true || workout.program?.deload === true,
        target: exercise.target,
        progression: exercise.progression,
        progressionDecision: progressionDecision(workout, entry),
        exerciseNote: exercise.exerciseNote,
        sessionNote: workout.note || null,
        readiness: workout.readiness || null,
        prs: workout.prs || [],
        sets: exercise.sets,
      }
    })
  return {
    format: 'opengym-exercise-history-v1',
    exerciseId,
    exercise: exerciseName(state, exerciseId),
    unit: state.unit || 'kg',
    sessions,
  }
}

export function exerciseHistoryPrompt(data) {
  return 'Should I increase the load for this exercise? Consider the rep targets, performance, RIR/RPE, notes, and progression decisions.\n\nTraining history:\n'
    + JSON.stringify(data, null, 2)
}

export const TRAINING_AI_PROMPT = [
  'Analyze my training over this period.',
  '',
  'Look for:',
  '- progression trends',
  '- stalled exercises',
  '- repeated missed rep targets',
  '- major drops in performance',
  '- accumulated fatigue patterns',
  '- whether a deload may be appropriate',
  '- exercises where load or rep range may need adjustment',
  '- patterns between bodyweight and performance',
  '- patterns involving RIR/RPE and performance',
  '',
  'Do not make medical diagnoses.',
  '',
  'Training data:'
].join('\n')
