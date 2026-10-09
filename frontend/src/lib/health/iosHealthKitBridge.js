import { MOBILE } from '../mobile.js'

export async function healthKitBridge() {
  if (!MOBILE) return null
  const { Capacitor, registerPlugin } = await import('@capacitor/core')
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'ios') return null
  return registerPlugin('HealthKit')
}
