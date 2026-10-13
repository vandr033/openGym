import { beforeEach, describe, expect, it } from 'vitest'
import { clearEmailOtpState, readEmailOtpState, writeEmailOtpState } from './email-otp-state.js'

describe('email OTP session recovery', () => {
  beforeEach(() => {
    const values = new Map()
    globalThis.sessionStorage = {
      clear: () => values.clear(),
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key)
    }
  })

  it('restores a live challenge for the same flow and invitation', () => {
    const state = { context: 'invite-token', challengeId: 'challenge', expiresAt: 2000 }
    writeEmailOtpState('join', state)
    expect(readEmailOtpState('join', 'invite-token', 1000)).toEqual(state)
    expect(readEmailOtpState('join', 'other-token', 1000)).toBeNull()
  })

  it('removes expired credentials and clears completed flows', () => {
    writeEmailOtpState('join', { context: 'invite-token', registrationState: 'signed-proof', expiresAt: 1000 })
    expect(readEmailOtpState('join', 'invite-token', 1000)).toBeNull()
    expect(sessionStorage.getItem('opengym-email-otp-join')).toBeNull()
    writeEmailOtpState('login', { challengeId: 'challenge', expiresAt: 2000 })
    clearEmailOtpState('login')
    expect(readEmailOtpState('login', null, 1000)).toBeNull()
  })
})
