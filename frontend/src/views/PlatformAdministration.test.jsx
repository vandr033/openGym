// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import PlatformAdministration from './PlatformAdministration.jsx'

const mocks = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../lib/api.js', () => ({ api: (...args) => mocks.api(...args) }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root, host
const mount = async path => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => {
    root.render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/platform/*" element={<PlatformAdministration />} /></Routes></MemoryRouter>)
    await Promise.resolve(); await Promise.resolve()
  })
}
afterEach(() => {
  if (root) act(() => root.unmount())
  host?.remove(); root = null; host = null; mocks.api.mockReset()
})

describe('Platform Administration', () => {
  it('shows a focused independent-trainer empty state', async () => {
    mocks.api.mockResolvedValue({ organizations: [], summary: { gyms: 0, trainerBusinesses: 0, trainers: 0, clients: 0, pendingInvitations: 0 } })
    await mount('/platform/trainers')
    expect(host.textContent).toContain('No independent trainers yet.')
    expect(host.textContent).toContain('Invite independent trainer')
    expect(host.textContent).not.toContain('Trainer business')
  })

  it('renders no management controls when the platform directory denies access', async () => {
    mocks.api.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }))
    await mount('/platform/organizations')
    expect(host.textContent).toContain('not found')
    expect(host.textContent).not.toContain('Create gym')
  })
})
