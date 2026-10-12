import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const app = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')

it('does not expose the removed Health screen route', () => {
  expect(app).not.toMatch(/<Route\s+path=["']\/health["']/)
  expect(app).not.toContain('HealthPreview')
  expect(app).toContain('<Route path="*" element={<Navigate to="/home" replace />} />')
})
