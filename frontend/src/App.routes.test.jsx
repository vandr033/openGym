import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const app = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')

it('does not expose the removed Health screen route', () => {
  expect(app).not.toMatch(/<Route\s+path=["']\/health["']/)
  expect(app).not.toContain('HealthPreview')
  expect(app).toContain('<Route path="*" element={<Navigate to="/home" replace />} />')
})

it('keeps SaaS platform, gym, and trainer routes separate from the legacy admin dashboard', () => {
  expect(app).toContain('<Route path="/platform" element={<PlatformAdministration />} />')
  expect(app).toContain('<Route path="/platform/trainers" element={<PlatformAdministration />} />')
  expect(app).toContain('<Route path="/platform/organizations" element={<PlatformAdministration />} />')
  expect(app).toContain('<Route path="/organizations/:organizationId/people" element={<Organization />} />')
  expect(app).toContain('<Route path="/trainer/clients" element={<Organization trainerWorkspace />} />')
  expect(app).toContain('<Route path="/admin" element={user?.admin ? <Admin /> : <Navigate to="/home" replace />} />')
})
