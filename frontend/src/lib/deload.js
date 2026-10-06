import { modeOf } from './history.js'
import { dropGrid } from './plates.js'
import { snapWeight } from './progression.js'

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value)))

// A generated deload is a separate routine definition. The source remains intact for future
// blocks and past workouts; the copy is excluded from progression so its lighter work cannot
// become the next normal baseline.
export function buildDeloadRoutine(state, routine, {
  id, name, loadMultiplier = 0.85, setMultiplier = 0.5,
} = {}) {
  if (!routine || !Array.isArray(routine.ex)) throw new Error('Choose a routine to deload.')
  const load = clamp(loadMultiplier, 0, 2)
  const sets = clamp(setMultiplier, 0.1, 2)
  return {
    ...JSON.parse(JSON.stringify(routine)),
    id: String(id || ''),
    name: String(name || (routine.name + ' · Deload')).slice(0, 80),
    excludeFromProgression: true,
    ex: routine.ex.map(cfg => {
      const out = { ...cfg, sets: Math.max(1, Math.round((Number(cfg.sets) || 1) * sets)) }
      if (Number(cfg.weight) > 0 && modeOf(cfg) !== 'cardio') {
        const target = cfg.weight * load
        const grid = dropGrid(state, cfg)
        out.weight = Math.round((typeof grid === 'function' ? grid(target) : snapWeight(target, grid)) * 100) / 100
      }
      return out
    })
  }
}
