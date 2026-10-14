// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import OrganizationHome from './OrganizationHome.jsx'

const mocks = vi.hoisted(() => ({ api: vi.fn(), nav: vi.fn() }))
vi.mock('../lib/api.js', () => ({ api: (...args) => mocks.api(...args) }))
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.nav }))
vi.mock('../store/useStore.js', () => ({ useStore: selector => selector({ config: { collab_workouts: true } }) }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root, host
const mount = async () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => { root.render(<OrganizationHome />); await Promise.resolve(); await Promise.resolve() })
}
afterEach(() => {
  if (root) act(() => root.unmount())
  host?.remove(); root = null; host = null
  mocks.api.mockReset(); mocks.nav.mockReset()
})

describe('Organization workspace navigation', () => {
  it('shows Platform Administration only when the SQL platform API grants access', async () => {
    mocks.api.mockImplementation(path => path.endsWith('/platform/me')
      ? Promise.resolve({ platformAdmin: true })
      : Promise.resolve({ organizations: [] }))
    await mount()
    const platform = [...host.querySelectorAll('button')].find(button => button.textContent.includes('Platform Administration'))
    expect(platform).toBeTruthy()
    await act(async () => platform.click())
    expect(mocks.nav).toHaveBeenCalledWith('/platform')
  })

  it('routes independent trainers and gym trainers into their scoped client workspace', async () => {
    mocks.api.mockImplementation(path => path.endsWith('/platform/me')
      ? Promise.reject(new Error('not found'))
      : Promise.resolve({ organizations: [
        { id: 'trainer-id', type: 'TRAINER_BUSINESS', name: 'Ana', membershipRole: 'OWNER' },
        { id: 'gym-id', type: 'GYM', name: 'Centro', membershipRole: 'TRAINER' }
      ] }))
    await mount()
    const trainerWorkspace = [...host.querySelectorAll('button')].find(button => button.textContent.includes('Independent Trainer'))
    await act(async () => trainerWorkspace.click())
    expect(mocks.nav).toHaveBeenLastCalledWith('/trainer/clients?workspace=trainer-id')
    const gymWorkspace = [...host.querySelectorAll('button')].find(button => button.textContent.includes('Centro'))
    await act(async () => gymWorkspace.click())
    expect(mocks.nav).toHaveBeenLastCalledWith('/trainer/clients?workspace=gym-id')
    expect([...host.querySelectorAll('button')].some(button => button.textContent.includes('Platform Administration'))).toBe(false)
  })

  it('routes gym owners into their organization People page', async () => {
    mocks.api.mockImplementation(path => path.endsWith('/platform/me')
      ? Promise.reject(new Error('not found'))
      : Promise.resolve({ organizations: [{ id: 'gym-id', type: 'GYM', name: 'Centro', membershipRole: 'OWNER' }] }))
    await mount()
    const workspace = [...host.querySelectorAll('button')].find(button => button.textContent.includes('Centro'))
    await act(async () => workspace.click())
    expect(mocks.nav).toHaveBeenCalledWith('/organizations/gym-id/people')
  })
})
