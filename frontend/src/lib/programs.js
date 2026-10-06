// Program blocks are date-based snapshots over the existing routine/week model. Dates are
// calendar dates (not timestamps), so every calculation is done in UTC to avoid DST drift.
const DAY = 86400000
const list = value => Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []
const isoMs = iso => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return NaN
  const ms = Date.parse(`${iso}T00:00:00Z`)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === iso ? ms : NaN
}
export const addDays = (iso, days) => {
  const ms = isoMs(iso)
  return Number.isFinite(ms) ? new Date(ms + Math.round(days) * DAY).toISOString().slice(0, 10) : null
}
export const daysBetween = (from, to) => {
  const a = isoMs(from), b = isoMs(to)
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / DAY) : null
}

const scheduleOf = schedule => Object.fromEntries(Array.from({ length: 7 }, (_, day) => {
  const routines = schedule?.[day]
  return [day, [...new Set(list(routines).filter(id => typeof id === 'string' && id))]]
}))

export function createProgram({ id, name, startDate, phases, schedule } = {}) {
  const cleanName = String(name || '').trim()
  const start = isoMs(startDate)
  if (!cleanName || cleanName.length > 80) throw new Error('Enter a program name (up to 80 characters).')
  if (!Number.isFinite(start)) throw new Error('Choose a valid program start date.')
  if (!Array.isArray(phases) || phases.length < 1 || phases.length > 16) throw new Error('A program needs 1–16 phases.')
  let phaseStart = startDate
  const cleanPhases = phases.map((phase, index) => {
    const phaseName = String(phase?.name || '').trim()
    const weeks = Math.round(Number(phase?.weeks))
    if (!phaseName || phaseName.length > 80) throw new Error(`Enter a name for phase ${index + 1}.`)
    if (weeks < 1 || weeks > 52) throw new Error(`Phase ${index + 1} must last 1–52 weeks.`)
    const out = {
      id: String(phase?.id || `phase-${index + 1}`),
      name: phaseName,
      weeks,
      startsOn: phaseStart,
      schedule: scheduleOf(phase?.schedule || schedule),
      ...(phase?.deload === true ? { deload: true } : {}),
    }
    phaseStart = addDays(phaseStart, weeks * 7)
    return out
  })
  return { id: String(id || ''), name: cleanName, startDate, phases: cleanPhases }
}

export function phaseForDate(program, iso) {
  if (!program || !Number.isFinite(isoMs(iso))) return null
  if (program.pausedAt && iso >= program.pausedAt) return null
  if (list(program.pauseRanges).some(range => range?.from <= iso && iso < range?.to)) return null
  const phases = list(program.phases)
  // Prefer the latest phase whose declared start is on or before this date. This also makes
  // "switch to this phase now" deterministic when prior phases remain in the history.
  let found = null
  for (let index = 0; index < phases.length; index++) {
    const phase = phases[index]
    const start = phase.startsOn || (index === 0 ? program.startDate : null)
    if (start && start <= iso && Number.isFinite(isoMs(start))) found = { phase, index, start }
  }
  if (!found) return null
  const next = phases[found.index + 1]
  const nextStart = next?.startsOn
  const end = nextStart || addDays(found.start, Math.max(1, Number(found.phase.weeks) || 1) * 7)
  if (iso >= end) return null
  return { ...found, end, program }
}

export function activeProgramContext(state, iso) {
  const program = list(state?.programs).find(item => item.id === state?.activeProgramId)
  const current = phaseForDate(program, iso)
  return current ? { ...current, deload: current.phase.deload === true } : null
}

export function programRoutineIds(state, iso) {
  const context = activeProgramContext(state, iso)
  if (!context) return null
  const weekday = new Date(`${iso}T12:00:00Z`).getUTCDay()
  const valid = new Set(list(state?.routines).map(routine => routine.id))
  return [...new Set(list(context.phase.schedule?.[weekday]).filter(id => valid.has(id)))]
}

export function extendPhase(program, phaseIndex) {
  const phases = list(program?.phases).map(phase => ({ ...phase }))
  if (!phases[phaseIndex]) return program
  phases[phaseIndex].weeks = Math.min(52, (Number(phases[phaseIndex].weeks) || 1) + 1)
  for (let index = phaseIndex + 1; index < phases.length; index++) {
    phases[index].startsOn = addDays(phases[index].startsOn, 7)
  }
  return { ...program, phases }
}

export function switchPhaseNow(program, phaseIndex, today) {
  const phases = list(program?.phases).map(phase => ({ ...phase }))
  if (!phases[phaseIndex] || !Number.isFinite(isoMs(today))) return program
  phases[phaseIndex].startsOn = today
  for (let index = phaseIndex + 1; index < phases.length; index++) {
    phases[index].startsOn = addDays(phases[index - 1].startsOn, phases[index - 1].weeks * 7)
  }
  return { ...program, phases, pausedAt: null }
}

export function pauseProgram(program, today) {
  return Number.isFinite(isoMs(today)) ? { ...program, pausedAt: today } : program
}

export function resumeProgram(program, today) {
  if (!program?.pausedAt || !Number.isFinite(isoMs(today))) return program
  const pausedDays = Math.max(0, daysBetween(program.pausedAt, today) || 0)
  const phases = list(program.phases).map((phase, index) => {
    const startsOn = phase.startsOn || (index === 0 ? program.startDate : null)
    if (startsOn > program.pausedAt) {
      return { ...phase, startsOn: addDays(startsOn, pausedDays) }
    }
    return { ...phase }
  })
  const pauseRanges = pausedDays > 0
    ? [...list(program.pauseRanges), { from: program.pausedAt, to: today }]
    : list(program.pauseRanges)
  return { ...program, phases, ...(pauseRanges.length ? { pauseRanges } : {}), pausedAt: null }
}

export const programHistorySnapshot = context => context ? ({
  programId: context.program.id,
  programName: context.program.name,
  phaseId: context.phase.id,
  phaseName: context.phase.name,
  phaseStart: context.start,
  deload: context.deload,
}) : null
