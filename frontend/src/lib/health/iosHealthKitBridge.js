import { MOBILE } from '../mobile.js'

let bridge

export async function healthKitBridge() {
  if (!MOBILE) {
    console.info('[HealthKit] JS bridge skipped: this is not a mobile build')
    return null
  }
  try {
    const { Capacitor, registerPlugin } = await import('@capacitor/core')
    const native = Capacitor.isNativePlatform()
    const platform = Capacitor.getPlatform()
    console.info('[HealthKit] Capacitor runtime:', { native, platform })
    if (!native || platform !== 'ios') return null
    if (!bridge) {
      console.info('[HealthKit] Registering JavaScript HealthKit proxy')
      const plugin = registerPlugin('HealthKit')
      // Capacitor plugin proxies are thenable; only return a plain object across async boundaries.
      bridge = {
        availability: (...args) => plugin.availability(...args),
        requestAccess: (...args) => plugin.requestAccess(...args),
        getData: (...args) => plugin.getData(...args),
      }
    }
    return bridge
  } catch (error) {
    console.error('[HealthKit] Could not load Capacitor HealthKit bridge:', error)
    throw error
  }
}
