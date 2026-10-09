import { beforeEach, describe, expect, it, vi } from 'vitest'
import { todayISO } from '../format.js'

const mocks = vi.hoisted(() => ({ bridge: null, file: null, api: vi.fn() }))
vi.mock('./iosHealthKitBridge.js', () => ({ healthKitBridge: async () => mocks.bridge }))
vi.mock('../api.js', () => ({ api: mocks.api }))
vi.mock('../mobile.js', () => ({
  readJsonFile: async () => mocks.file,
  writeJsonFile: async (_, data) => { mocks.file = data },
}))
import { getTodayHealthSummary, getHealthSummaryForDate, getHealthSummaries, getRecentHealthWorkouts, healthSyncEnabled, healthSyncRange, readHealthCache, requestHealthAccess, setHealthSyncEnabled, syncHealthToServer } from './healthService.js'

beforeEach(() => { mocks.bridge = null; mocks.file = null; mocks.api.mockReset() })

describe('health query service', () => {
  it('degrades on web and non-iOS without calling HealthKit', async () => {
    await expect(getTodayHealthSummary()).rejects.toThrow('unavailable on this platform')
    await expect(requestHealthAccess()).rejects.toThrow('unavailable on this platform')
  })

  it('keeps empty and partial reads local, cached and distinct from permission grants', async () => {
    const getData = vi.fn(async () => ({ stats: [{ date: '2026-10-08', type: 'steps', value: 23 }], samples: [], sleep: [], workouts: [] }))
    mocks.bridge = { availability: async () => ({ available: true }), requestAccess: vi.fn(async () => ({})), getData }
    await requestHealthAccess()
    expect((await readHealthCache()).requested).toBe(true)
    expect(await getHealthSummaryForDate('2026-10-08')).toEqual({ date: '2026-10-08', steps: 23 })
    expect(await getHealthSummaries('2026-10-07', '2026-10-08')).toEqual([{ date: '2026-10-07' }, { date: '2026-10-08', steps: 23 }])
    expect(await getRecentHealthWorkouts('2026-10-08', '2026-10-08')).toEqual([])
    expect(mocks.file.summaries['2026-10-08']).toEqual({ date: '2026-10-08', steps: 23 })
    expect(mocks.file.lastSync).toBeTruthy()
    expect(getData).toHaveBeenCalledTimes(3)
  })

  it('rejects bad ranges before querying', async () => {
    await expect(getHealthSummaries('2026-10-09', '2026-10-08')).rejects.toThrow('Invalid health date range')
    await expect(getHealthSummaries('2026-02-30', '2026-03-01')).rejects.toThrow('Invalid health date range')
  })
})

describe('opt-in server health sync', () => {
  const target = { server: 'https://gym.example', uid: 'alice' }

  it('starts with 30 days, then overlaps two days, and ties consent to the paired user', async () => {
    expect(healthSyncRange({}, '2026-10-08')).toEqual({ from: '2026-09-09', to: '2026-10-08' })
    expect(healthSyncRange({ syncCursor: '2026-10-05' }, '2026-10-08')).toEqual({ from: '2026-10-03', to: '2026-10-08' })
    expect(healthSyncRange({ syncCursor: '2026-08-01' }, '2026-10-08')).toEqual({ from: '2026-07-30', to: '2026-08-28' })
    await setHealthSyncEnabled(true, target)
    expect(healthSyncEnabled(await readHealthCache(), target)).toBe(true)
    expect(healthSyncEnabled(await readHealthCache(), { ...target, uid: 'bob' })).toBe(false)
    await setHealthSyncEnabled(false, target)
    expect(healthSyncEnabled(await readHealthCache(), target)).toBe(false)
  })

  it('uploads normalized summaries only after consent, retries failure, and advances only on acknowledgement', async () => {
    const today = todayISO()
    const getData = vi.fn(async () => ({ stats: [{ date: today, type: 'steps', value: 123 }], samples: [], sleep: [], workouts: [] }))
    mocks.bridge = { availability: async () => ({ available: true }), requestAccess: async () => ({}), getData }
    await requestHealthAccess()
    expect(await syncHealthToServer(target, { force: true })).toBe(false)
    expect(getData).not.toHaveBeenCalled()
    await setHealthSyncEnabled(true, target)
    mocks.api.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ok: true })
    await expect(syncHealthToServer(target, { force: true })).rejects.toThrow('offline')
    expect((await readHealthCache()).syncCursor).toBeNull()
    await expect(syncHealthToServer(target)).resolves.toBe(true)
    const body = JSON.parse(mocks.api.mock.calls[1][1].body)
    expect(body.daily).toEqual([{ date: today, steps: 123, source: 'apple-health' }])
    expect(body.workouts).toEqual([])
    expect((await readHealthCache()).serverSyncAt).toBeTruthy()
    expect((await readHealthCache()).syncCursor).toBeTruthy()
    expect(getData).toHaveBeenCalledTimes(1)
  })
})
