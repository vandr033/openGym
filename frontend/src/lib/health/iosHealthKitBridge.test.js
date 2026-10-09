import { beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ mobile: false, platform: 'web', native: false, register: vi.fn() }))
vi.mock('../mobile.js', () => ({ get MOBILE() { return mock.mobile } }))
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => mock.platform, isNativePlatform: () => mock.native },
  registerPlugin: mock.register,
}))
import { healthKitBridge } from './iosHealthKitBridge.js'

beforeEach(() => { mock.mobile = false; mock.platform = 'web'; mock.native = false; mock.register.mockClear() })

it('only registers the HealthKit plugin inside the native iOS mobile shell', async () => {
  expect(await healthKitBridge()).toBeNull()
  mock.mobile = true
  mock.platform = 'android'; mock.native = true
  expect(await healthKitBridge()).toBeNull()
  mock.platform = 'ios'; mock.native = false
  expect(await healthKitBridge()).toBeNull()
  expect(mock.register).not.toHaveBeenCalled()
  mock.native = true
  await healthKitBridge()
  expect(mock.register).toHaveBeenCalledExactlyOnceWith('HealthKit')
})
