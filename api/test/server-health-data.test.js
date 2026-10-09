import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { boundPort } from './helpers.mjs'

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SECRET = crypto.randomBytes(32).toString('hex')
const token = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
}
async function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-health-'))
  fs.writeFileSync(path.join(dir, 'secret'), SECRET, { mode: 0o600 })
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ users: [{ id: 'a', name: 'A', admin: true }, { id: 'b', name: 'B' }], creds: [], subs: [], invites: [] }))
  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: '0', DATA_DIR: dir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' } })
  let log = ''
  child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d)
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }) })
  const port = await boundPort(child, () => log)
  const request = async (route, { method = 'GET', uid, bearer = false, body } = {}) => {
    const headers = { 'Content-Type': 'application/json', ...(uid ? bearer ? { Authorization: `Bearer ${token(uid)}` } : { Cookie: `gymsid=${token(uid)}` } : {}) }
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: r.status, body: await r.json() }
  }
  return { request, dir }
}
const day = { date: '2026-10-08', source: 'apple-health', steps: 6000, sleep: { totalMinutes: 450, deepMinutes: 60, startAt: '2026-10-07T22:00:00Z', endAt: '2026-10-08T06:00:00Z' } }
const workout = { externalId: 'HK-UUID-1', source: 'apple-health', workoutType: 'traditionalStrengthTraining', startAt: '2026-10-08T12:00:00Z', endAt: '2026-10-08T13:00:00Z', durationSeconds: 3600, averageHeartRateBpm: 128 }

test('health upload uses existing auth, isolates users, validates and deduplicates', async t => {
  const { request, dir } = await start(t)
  const put = (uid, body, bearer = false) => request('/api/health-data', { method: 'PUT', uid, bearer, body })
  const get = uid => request('/api/health-data', { uid })
  assert.equal((await get()).status, 401)
  assert.equal((await put(null, { daily: [day], workouts: [workout] })).status, 401)
  assert.equal((await put('b', { daily: [day], workouts: [workout] }, true)).status, 200)
  let saved = (await get('b')).body
  assert.equal(saved.daily.length, 1); assert.equal(saved.workouts.length, 1)
  assert.ok(saved.daily[0].importedAt)
  const importedAt = saved.daily[0].importedAt
  assert.deepEqual((await get('a')).body, { daily: [], workouts: [] })
  assert.equal((await put('b', { daily: [day], workouts: [workout] }, true)).status, 200)
  saved = (await get('b')).body
  assert.equal(saved.daily.length, 1); assert.equal(saved.workouts.length, 1)
  assert.equal(saved.daily[0].importedAt, importedAt)
  assert.equal((await put('b', { daily: [{ ...day, steps: 7000, sleep: { totalMinutes: 440 } }], workouts: [{ ...workout, averageHeartRateBpm: 130 }] })).status, 200)
  saved = (await get('b')).body
  assert.equal(saved.daily[0].steps, 7000)
  assert.deepEqual(saved.daily[0].sleep, { totalMinutes: 440, deepMinutes: 60, startAt: day.sleep.startAt, endAt: day.sleep.endAt })
  assert.equal((await put('b', { daily: [{ date: day.date, source: day.source, restingHeartRateBpm: 55 }], workouts: [] })).status, 200)
  saved = (await get('b')).body
  assert.equal(saved.daily[0].steps, 7000)
  assert.equal(saved.daily[0].restingHeartRateBpm, 55)
  assert.equal(saved.workouts[0].averageHeartRateBpm, 130)
  assert.equal((await put('b', { daily: [{ ...day, rawHeartRateSamples: [1, 2] }], workouts: [] })).status, 400)
  assert.equal(fs.statSync(path.join(dir, 'health-b.json')).mode & 0o777, 0o600)
})

test('duplicate links are refused and admin drill-down omits linked health fields', async t => {
  const { request, dir } = await start(t)
  const { source, ...link } = workout
  const state = { workouts: [{ id: 'w1', d: '2026-10-08', appleHealth: link }], routines: [] }
  assert.equal((await request('/api/data', { method: 'PUT', uid: 'b', body: { state } })).status, 200)
  assert.equal('appleHealth' in (await request('/api/admin/user?id=b', { uid: 'a' })).body.workouts[0], false)
  const duplicate = { workouts: [...state.workouts, { id: 'w2', d: '2026-10-08', appleHealth: link }], routines: [] }
  assert.equal((await request('/api/data', { method: 'PUT', uid: 'b', body: { state: duplicate } })).status, 400)
  assert.equal((await request('/api/data', { method: 'PUT', uid: 'b', body: { state: { ...state, workouts: [{ ...state.workouts[0], appleHealth: { ...link, rawHeartRateSamples: [80, 90] } }] } } })).status, 400)
  await request('/api/health-data', { method: 'PUT', uid: 'b', body: { daily: [day], workouts: [] } })
  assert.equal((await request('/api/admin/user/delete', { method: 'POST', uid: 'a', body: { id: 'b' } })).status, 200)
  assert.equal(fs.existsSync(path.join(dir, 'health-b.json')), false)
})
