import { uid } from './format.js'
import { modeOf, defaultConfig, isPerSide, entryRoutineId } from './history.js'
import { isSideSet, isWarmupRow } from './workout-model.js'

// A saved workout is evidence of what was logged, not a live routine. Copy only its flat
// exercise setup on this explicit action; finishing a workout never calls this helper.
const sessionEntries = session => Array.isArray(session?.entries) ? session.entries : []

function groupIds(ex) {
  const next = ex.map(entry => ({ ...entry }))
  let i = 0
  while (i < next.length) {
    const raw = next[i].sg
    if (raw == null || raw === '') { delete next[i].sg; i++; continue }
    const start = i
    while (i + 1 < next.length && next[i + 1].sg === raw) i++
    const end = i
    if (end === start) delete next[start].sg
    else {
      const mapped = `sg-${uid()}`
      for (let j = start; j <= end; j++) next[j].sg = mapped
    }
    i++
  }
  return next
}

const scalarGroup = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value)
  return text ? text : null
}

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null
const positive = value => {
  const n = finite(value)
  return n != null && n > 0 ? n : null
}

// A flat per-side routine stores the total across both limbs. makeSideSet() then splits that
// total into two equal planned sides, so an odd/asymmetric logged total is rounded to the nearest
// representable even total. The copy keeps the target when only one limb was completed: a flat
// routine cannot encode partial completion or two different side prescriptions.
function perSideReps(row, target) {
  if (!isSideSet(row)) return positive(row?.r)
  const done = ['L', 'R'].filter(key => row.sides[key]?.done === true)
  if (done.length === 1) return evenTotal(target?.reps) ?? evenTotal(row.sides[done[0]]?.r)
  if (done.length < 2) return null
  return evenTotal(done.reduce((total, key) => total + (positive(row.sides[key]?.r) || 0), 0))
}

function evenTotal(value) {
  const n = positive(value)
  return n == null ? null : Math.max(2, 2 * Math.round(n / 2))
}

function perSideWeight(row) {
  if (!isSideSet(row)) return finite(row?.w)
  const done = ['L', 'R'].filter(key => row.sides[key]?.done === true)
  const weights = done.map(key => finite(row.sides[key]?.w)).filter(value => value != null)
  return weights.length ? Math.max(...weights) : null
}

function copiedEntry(entry, source) {
  const rows = Array.isArray(entry?.sets) ? entry.sets : []
  const work = rows.filter(row => !isWarmupRow(row))
  // A saved entry can retain planned rows after an early finish. Match history.js lastEntryFor:
  // only a fully completed work row may seed the copied target. A partially checked per-side row
  // is still retained by buildCompletedWorkout, but its two-limb state cannot fit a flat routine.
  const row = work.filter(candidate => candidate?.done === true).at(-1) || null
  const target = entry?.target && typeof entry.target === 'object'
    ? structuredClone(entry.target)
    : {}
  const cfg = { ...defaultConfig(entry?.id), ...target, id: entry?.id, sets: Math.max(1, work.length || 1), warmupSets: rows.filter(isWarmupRow).length }
  const mode = modeOf(cfg)
  if (mode === 'time' && row) Object.assign(cfg, { sec: row.sec ?? cfg.sec, weight: row.w ?? cfg.weight ?? 0 })
  else if (mode === 'cardio' && row) Object.assign(cfg, { min: row.min ?? cfg.min, speed: row.speed ?? cfg.speed })
  else if (mode === 'reps') {
    const reps = row && isPerSide(cfg) ? perSideReps(row, cfg) : positive(row?.r)
    if (reps != null) cfg.reps = reps
    if (row) {
      const weight = perSideWeight(row)
      if (weight != null) cfg.weight = weight
    }
    if (isPerSide(cfg) && row == null) cfg.reps = evenTotal(cfg.reps) ?? cfg.reps
  }

  // A planned entry says what its routine asked for (`planned`, session-start.js), and the plan
  // owns a planned session's sets and reps. Today's target is the prescription and the rows are
  // what was done with it: a double-progression aim inside the range, a set the bodyweight
  // ceiling added, a bonus set, or reps carried over from last time. Copied as the new plan,
  // each of those reads as an edited plan on the copy's first session (nextPrescription):
  // "Plan changed", a range narrowed to the reps of one day, the climb started again. The copy
  // takes the plan's sets and reps instead, so it continues from where the source routine
  // stands. The weight is still the one lifted — history decides it either way.
  const planned = entry?.planned && typeof entry.planned === 'object' ? entry.planned : null
  if (planned) {
    cfg.sets = Math.max(1, positive(planned.sets) || 1)
    if (mode === 'reps' && positive(planned.reps) != null) {
      cfg.reps = planned.reps
      // A plan with no range has no bottom to keep, whatever the target carried.
      if (positive(planned.repsMin) != null) cfg.repsMin = planned.repsMin
      else delete cfg.repsMin
    }
    if (mode === 'time' && positive(planned.sec) != null) cfg.sec = planned.sec
  }
  // A rule set on the source routine rather than on the exercise decides how the plan is read:
  // a range is a double-progression aim there and a flat target under the default. A copy
  // without it would open 3 × 8–12 at 12. Each exercise keeps its own routine's rule, since a
  // combined session can hold routines that progress differently.
  if (!cfg.prog && typeof source?.prog === 'string' && source.prog) cfg.prog = source.prog

  // buildCompletedWorkout carries setup.sg inside target, while older records may carry it on
  // the entry. Keep either form, but never copy session-only ownership fields such as rid.
  const sg = scalarGroup(entry?.sg ?? target.sg)
  if (sg) cfg.sg = sg
  else delete cfg.sg
  // What a session stamps on its entries describes that session, not a plan. None of it belongs
  // in a routine: a copied `planned` or `rid` would tell the next session it had been built from
  // another plan or another routine.
  for (const key of SESSION_ONLY) delete cfg[key]
  return cfg
}

const SESSION_ONLY = ['planned', 'plan', 'carried', 'rid', 'noProg', 'muscleSnapshot']

const TEMPLATE_FIELDS = new Set(['id', 'sets', 'warmupSets', 'sg'])
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function configFromActiveEntry(entry, original) {
  const target = entry?.target && typeof entry.target === 'object' ? entry.target : original || {}
  const config = { ...target, id: entry?.id }
  const planned = entry?.planned
  if (planned) {
    if (planned.sets != null) config.sets = planned.sets
    if (planned.reps != null) config.reps = planned.reps
    if (planned.repsMin != null) config.repsMin = planned.repsMin
    else delete config.repsMin
    if (planned.sec != null) config.sec = planned.sec
    if (planned.weight != null) config.weight = planned.weight
  }
  const rows = Array.isArray(entry?.sets) ? entry.sets : []
  const workCount = rows.filter(row => !isWarmupRow(row)).length
  const plannedSets = Number(planned?.sets) || workCount || 1
  const todaySets = Number(entry?.target?.sets) || plannedSets
  // Keep automatic progression's extra sets out, while retaining sets added or removed by hand.
  config.sets = Math.max(1, plannedSets + workCount - todaySets)
  config.warmupSets = rows.filter(isWarmupRow).length
  if (entry?.sg) config.sg = entry.sg
  else delete config.sg
  for (const key of SESSION_ONLY) delete config[key]
  delete config.routineIndex
  return config
}

// Build separate finish choices: routine values update existing slots; a template save also
// applies additions, removals, order and set counts. Saved routine definitions drive every future use.
export function sessionRoutineChanges(active, routines = []) {
  const ids = new Set([].concat(active?.routineIds || [], active?.routineId || [], (active?.entries || []).map(entry => entry?.rid)).filter(Boolean))
  const changes = { values: [], templates: [] }
  for (const id of ids) {
    const routine = routines.find(item => item?.id === id)
    if (!routine) continue
    const source = Array.isArray(routine.ex) ? routine.ex : []
    const entries = (active?.entries || []).filter(entry => entry?.rid === id)
    const used = new Set()
    const current = entries.map(entry => {
      let index = Number.isInteger(entry.routineIndex) ? entry.routineIndex : source.findIndex((item, i) => item?.id === entry.id && !used.has(i))
      if (index >= 0) used.add(index)
      else index = null
      return { entry, index, config: configFromActiveEntry(entry, index == null ? null : source[index]) }
    })
    const templateChanged = current.length !== source.length || current.some(({ entry, index, config }, position) => {
      const original = source[position]
      return index !== position || !original || entry.id !== original.id || config.sets !== original.sets || config.warmupSets !== (original.warmupSets || 0) || !same(config.sg, original.sg)
    })
    const values = current.flatMap(({ entry, index, config }) => {
      const original = index == null ? null : source[index]
      if (!original || entry.id !== original.id) return []
      const keys = [...new Set([...Object.keys(original), ...Object.keys(config)])]
        .filter(key => !TEMPLATE_FIELDS.has(key) && !same(original[key], config[key]))
      return keys.length ? [{ index, id: original.id, keys, config }] : []
    })
    if (values.length) changes.values.push({ id, values })
    if (templateChanged) changes.templates.push({ id, ex: current.map(item => item.config) })
  }
  return changes.values.length || changes.templates.length ? changes : null
}

export function applySessionRoutineChanges(state, changes, kind) {
  for (const change of changes?.[kind] || []) {
    const routine = state.routines.find(item => item?.id === change.id)
    if (!routine) continue
    if (kind === 'templates') { routine.ex = structuredClone(change.ex); continue }
    for (const { index, id, keys, config } of change.values) {
      const target = routine.ex?.[index]
      if (!target || target.id !== id) continue
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(config, key)) target[key] = structuredClone(config[key])
        else delete target[key]
      }
    }
  }
}

// `routines` are the ones the session was built from, when they still exist: the rule each copied
// exercise is read under comes from there (see copiedEntry).
export function routineFromSession(session, name = session?.name, routines = []) {
  const byId = new Map((Array.isArray(routines) ? routines : []).filter(r => r?.id != null).map(r => [r.id, r]))
  const ex = groupIds(sessionEntries(session).filter(entry => entry?.sets?.length)
    .map(entry => copiedEntry(entry, byId.get(entryRoutineId(session, entry)))))
  if (!ex.length) throw new Error('no exercises')
  return { id: uid(), name: String(name || 'Workout').trim() || 'Workout', ex }
}

export function saveSessionAsRoutine(state, session, name) {
  const routine = routineFromSession(session, name, state.routines)
  state.routines.push(routine)
  return routine.id
}
