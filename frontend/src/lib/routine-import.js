import { allExercises, EXIDX, normalizeStr, searchExercises } from './exercises.js'
import { bpFromName, matchExercise } from './import-csv.js'
import { uid } from './format.js'
import { convertWeight } from './units.js'

export const ROUTINE_FORMAT = 'opengym-routine-v1'
export const ROUTINE_TEMPLATE = {
  format: ROUTINE_FORMAT,
  _instructions: 'Use conventional exercise names. Each routine has a name, an exercises list, and optional deload: true. Each exercise uses exercise, sets, repRange min/max, optional weight and weightUnit (kg or lb), restSeconds, progression type and step, and optional notes. Schedule uses weekday names and routine names from this file.',
  name: 'Upper Lower Hypertrophy',
  schedule: [
    { day: 'monday', routine: 'Upper A' },
    { day: 'tuesday', routine: 'Lower A' },
    { day: 'thursday', routine: 'Upper A' },
    { day: 'friday', routine: 'Lower A' }
  ],
  routines: [
    {
      name: 'Upper A',
      deload: false,
      exercises: [
        {
          exercise: 'Incline Dumbbell Bench Press',
          sets: 3,
          repRange: { min: 8, max: 12 },
          weight: 30,
          weightUnit: 'kg',
          restSeconds: 180,
          progression: { type: 'double', step: 2 },
          notes: '2 RIR, controlled eccentric'
        },
        {
          exercise: 'Lat Pulldown',
          sets: 3,
          repRange: { min: 8, max: 12 },
          restSeconds: 120,
          progression: { type: 'double', step: 2.5 },
          notes: 'Pause briefly at the chest'
        }
      ]
    },
    {
      name: 'Lower A',
      deload: false,
      exercises: [
        {
          exercise: 'Barbell Squat',
          sets: 4,
          repRange: { min: 6, max: 10 },
          weight: 80,
          weightUnit: 'kg',
          restSeconds: 180,
          progression: { type: 'double', step: 2.5 },
          notes: 'Keep 1–2 reps in reserve'
        }
      ]
    },
    {
      name: 'Deload A',
      deload: true,
      exercises: [
        {
          exercise: 'Barbell Squat',
          sets: 2,
          repRange: { min: 6, max: 8 },
          weight: 65,
          weightUnit: 'kg',
          restSeconds: 150,
          progression: { type: 'off' },
          notes: 'Easy technique work'
        }
      ]
    }
  ]
}

const DAY_INDEX = Object.fromEntries(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map((day, index) => [day, index]))
const cleanName = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim()
const keyName = value => cleanName(value).toLocaleLowerCase('en')
const unitOf = unit => unit === 'lb' ? 'lb' : unit === 'kg' ? 'kg' : null
const validNumber = (value, min, max, label, integer = false) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error(label + ' is outside the allowed range.')
  return n
}
const nameWords = value => new Set(normalizeStr(value).split(/[^a-z0-9]+/).filter(Boolean))

function candidateList(name, exercises) {
  const q = nameWords(name)
  return searchExercises(exercises, name).map(ex => {
    const words = nameWords(ex.n)
    const overlap = [...q].filter(word => words.has(word)).length
    const score = q.size ? overlap / q.size - Math.max(0, words.size - q.size) * 0.025 : 0
    return { id: ex.id, name: ex.n, score }
  }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 5)
}

function exerciseMatch(name, exercises) {
  const norm = keyName(name)
  const exact = exercises.find(ex => keyName(ex.n) === norm)
  if (exact) return { status: 'exact', selectedId: exact.id, candidates: [{ id: exact.id, name: exact.n }] }
  const safe = matchExercise(name)
  if (safe && exercises.some(ex => ex.id === safe)) {
    const ex = exercises.find(item => item.id === safe)
    const alternatives = candidateList(name, exercises)
    const candidates = [{ id: safe, name: ex.n, score: 1 }, ...alternatives.filter(item => item.id !== safe)].slice(0, 5)
    return { status: 'likely', selectedId: safe, candidates }
  }
  const candidates = candidateList(name, exercises)
  if (!candidates.length) return { status: 'unmatched', selectedId: 'custom', candidates: [] }
  const tied = candidates.length > 1 && candidates[0].score - candidates[1].score < 0.1
  if (!tied && candidates[0].score >= 0.72) {
    return { status: 'likely', selectedId: candidates[0].id, candidates }
  }
  return { status: 'ambiguous', selectedId: '', candidates }
}

function normalizeExercise(source, unit, exercises) {
  if (typeof source !== 'string' && (!source || typeof source !== 'object' || Array.isArray(source))) {
    throw new Error('Each exercise must be a name or an exercise object.')
  }
  const name = cleanName(typeof source === 'string' ? source : source?.exercise)
  if (!name || name.length > 120) throw new Error('Each exercise needs a name of up to 120 characters.')
  const cfg = typeof source === 'string' ? {} : source
  if (cfg.repRange != null && (typeof cfg.repRange !== 'object' || Array.isArray(cfg.repRange))) throw new Error('Rep range must have min and max numbers.')
  if (cfg.progression != null && (typeof cfg.progression !== 'object' || Array.isArray(cfg.progression))) throw new Error('Progression must be an object with a type and optional step.')
  if (cfg.weightUnit != null && !unitOf(cfg.weightUnit)) throw new Error('Weight unit must be kg or lb.')
  if (cfg.notes != null && typeof cfg.notes !== 'string') throw new Error('Exercise notes must be plain text.')
  const sets = validNumber(cfg.sets ?? 3, 1, 30, 'Set count', true)
  const range = cfg.repRange || {}
  const min = validNumber(range.min ?? cfg.reps ?? 8, 1, 100, 'Minimum reps', true)
  const max = validNumber(range.max ?? cfg.reps ?? 12, min, 100, 'Maximum reps', true)
  const externalUnit = unitOf(cfg.weightUnit) || unit
  let weight, step
  if (cfg.weight != null) {
    weight = validNumber(cfg.weight, 0, 2000, 'Weight')
    if (weight && externalUnit !== unit) weight = convertWeight(weight, externalUnit, unit)
  }
  const restSec = cfg.restSeconds == null ? null : validNumber(cfg.restSeconds, 1, 3600, 'Rest time', true)
  const progressionType = String(cfg.progression?.type || (range.min != null ? 'double' : 'linear')).toLowerCase()
  const progression = ({ double: 'double', 'double progression': 'double', linear: 'linear', greyskull: 'greyskull', off: 'off', none: 'off' })[progressionType]
  if (!progression) throw new Error('Unsupported progression type: ' + progressionType)
  if (cfg.progression?.step != null) {
    step = validNumber(cfg.progression.step, 0.01, 100, 'Progression step')
    if (progressionType !== 'off' && externalUnit !== unit) step = convertWeight(step, externalUnit, unit)
  }
  const config = {
    sets, reps: max, ...(min < max ? { repsMin: min } : {}),
    ...(weight != null ? { weight } : {}),
    ...(restSec != null ? { restSec } : {}),
    ...(progression ? { prog: progression } : {}),
    ...(step != null ? { inc: step } : {}),
    ...(cleanName(cfg.notes) ? { note: cleanName(cfg.notes).slice(0, 500) } : {})
  }
  return { name, config, match: exerciseMatch(name, exercises) }
}

export function parseRoutineImport(input, { unit = 'kg', state = {} } = {}) {
  let data
  try { data = typeof input === 'string' ? JSON.parse(input) : input } catch { throw new Error('This is not valid JSON.') }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.format !== ROUTINE_FORMAT) {
    throw new Error('Expected a JSON object with format "' + ROUTINE_FORMAT + '".')
  }
  if (data.name != null && typeof data.name !== 'string') throw new Error('The plan name must be text.')
  const planName = cleanName(data.name)
  if (planName.length > 100) throw new Error('The plan name is too long.')
  if (!Array.isArray(data.routines) || !data.routines.length || data.routines.length > 16) throw new Error('Add 1–16 routines to the JSON.')
  const routines = data.routines.map((routine, index) => {
    if (!routine || typeof routine !== 'object' || Array.isArray(routine)) throw new Error('Routine ' + (index + 1) + ' must be an object.')
    if (routine.deload != null && typeof routine.deload !== 'boolean') throw new Error('Routine deload must be true or false.')
    const name = cleanName(routine?.name)
    if (!name || name.length > 80) throw new Error('Routine ' + (index + 1) + ' needs a name of up to 80 characters.')
    if (!Array.isArray(routine.exercises) || !routine.exercises.length || routine.exercises.length > 100) {
      throw new Error('Routine "' + name + '" needs 1–100 exercises.')
    }
    return {
      name, deload: routine.deload === true,
      exercises: routine.exercises.map(ex => normalizeExercise(ex, unitOf(unit) || 'kg', allExercises(state)))
    }
  })
  const names = new Set()
  for (const routine of routines) {
    const key = keyName(routine.name)
    if (names.has(key)) throw new Error('Routine names must be unique in the import: "' + routine.name + '".')
    names.add(key)
  }
  const routineNames = new Set(routines.map(r => keyName(r.name)))
  const schedule = []
  if (data.schedule != null) {
    if (!Array.isArray(data.schedule) || data.schedule.length > 56) throw new Error('Schedule must be a list of weekday/routine pairs.')
    for (const item of data.schedule) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Each schedule entry must name a weekday and routine.')
      const dayName = cleanName(item?.day).toLowerCase()
      const routineName = cleanName(item?.routine)
      if (!(dayName in DAY_INDEX) || !routineNames.has(keyName(routineName))) {
        throw new Error('Every schedule entry must name a weekday and an imported routine.')
      }
      schedule.push({ day: DAY_INDEX[dayName], routine: routineName })
    }
  }
  return { format: ROUTINE_FORMAT, name: planName, routines, schedule }
}

const uniqueName = (name, names, suffix) => {
  let value = name, index = 2
  while (names.has(keyName(value))) value = name + ' (' + suffix + ' ' + index++ + ')'
  names.add(keyName(value))
  return value
}

export function applyRoutineImport(state, parsed, {
  choices = {}, collision = 'version', applySchedule = true, idFactory = uid,
} = {}) {
  if (collision === 'cancel') return { cancelled: true }
  state.routines = state.routines || []
  state.customEx = state.customEx || []
  state.week = state.week || {}
  const sameName = new Map((state.routines || []).map(r => [keyName(r.name), r]))
  const existingNames = new Set((state.routines || []).map(r => keyName(r.name)))
  const routineIds = new Map()
  const created = []
  const customByName = new Map()
  for (let ri = 0; ri < parsed.routines.length; ri++) {
    const incoming = parsed.routines[ri]
    const collisionRoutine = sameName.get(keyName(incoming.name))
    const id = idFactory()
    let routineName = incoming.name
    if (collisionRoutine && collision === 'replace') {
      const archived = uniqueName(incoming.name + ' · Archived', existingNames, 'Version')
      collisionRoutine.name = archived
      // Keep the older definition available to workout and program history.
      for (const day of Object.keys(state.week || {})) {
        state.week[day] = [].concat(state.week[day] || []).map(rid => rid === collisionRoutine.id ? id : rid)
      }
      for (const program of state.programs || []) for (const phase of program.phases || []) {
        for (const day of Object.keys(phase.schedule || {})) {
          phase.schedule[day] = [].concat(phase.schedule[day] || []).map(rid => rid === collisionRoutine.id ? id : rid)
        }
      }
    } else if (collisionRoutine) {
      routineName = uniqueName(incoming.name, existingNames, 'Version')
    } else existingNames.add(keyName(incoming.name))
    const exercises = []
    for (let ei = 0; ei < incoming.exercises.length; ei++) {
      const item = incoming.exercises[ei]
      const choice = choices[ri + ':' + ei] ?? item.match.selectedId
      let exerciseId = typeof choice === 'string' ? choice : ''
      if (choice === 'custom') {
        const normalizedKey = keyName(item.name)
        if (customByName.has(normalizedKey)) exerciseId = customByName.get(normalizedKey)
        else {
          exerciseId = 'c' + idFactory()
          customByName.set(normalizedKey, exerciseId)
          state.customEx = state.customEx || []
          state.customEx.push({
            id: exerciseId, n: item.name, bp: bpFromName(item.name) || 'upper legs',
            eq: 'custom', tg: '', custom: true,
          })
        }
      }
      if (!exerciseId || (choice !== 'custom' && !EXIDX[exerciseId] && !(state.customEx || []).some(ex => ex.id === exerciseId))) {
        throw new Error('Choose a match or create a custom exercise for "' + item.name + '".')
      }
      exercises.push({ id: exerciseId, ...item.config })
    }
    const routine = {
      id, name: routineName, ex: exercises,
      ...(incoming.deload ? { excludeFromProgression: true } : {}),
    }
    state.routines.push(routine)
    routineIds.set(keyName(incoming.name), id)
    created.push(routine)
  }
  if (applySchedule && parsed.schedule.length) {
    state.week = {}
    for (const { day, routine } of parsed.schedule) {
      const id = routineIds.get(keyName(routine))
      if (id) state.week[day] = [...new Set([...(state.week[day] || []), id])]
    }
  }
  return { cancelled: false, created, scheduleApplied: !!(applySchedule && parsed.schedule.length) }
}
