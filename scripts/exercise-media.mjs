#!/usr/bin/env node
// Lists missing built-in exercise media and fills those catalog filenames from direct image URLs.
import { existsSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mediaDir = join(root, 'media')
const { EXDB } = await import(pathToFileURL(join(root, 'frontend/src/lib/exercises-data.js')).href)
const byId = new Map(EXDB.map(ex => [ex.id, ex]))
const kinds = ['img', 'gif']

function fileFor(ex, kind) {
  const file = ex[kind]
  const extension = kind === 'img' ? /\.jpe?g$/i : /\.gif$/i
  if (typeof file !== 'string' || !extension.test(file) || basename(file) !== file) return null
  return join(mediaDir, kind === 'img' ? 'img' : 'gif', file)
}

function exists(file) {
  if (!file) return false
  try {
    const stat = statSync(file)
    return stat.isFile() && stat.size > 0
  } catch { return false }
}

function missingFor(ex) {
  return kinds.filter(kind => !exists(fileFor(ex, kind)))
}

function list() {
  const rows = EXDB.flatMap(ex => {
    const missing = missingFor(ex)
    return missing.length ? [{ id: ex.id, name: ex.n, missing, ...Object.fromEntries(missing.map(kind => [kind, ''])) }] : []
  })
  process.stdout.write(JSON.stringify(rows, null, 2) + '\n')
}

function httpsUrl(value, label) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error(`${label} must be an HTTPS URL`)
  let url
  try { url = new URL(value) } catch { throw new Error(`${label} must be an HTTPS URL`) }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${label} must be an HTTPS URL without credentials`)
  return url
}

function importJobs(file) {
  const rows = JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8'))
  if (!Array.isArray(rows)) throw new Error('The import file must be the JSON array produced by the list command.')
  const seen = new Set()
  const jobs = []
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Each import entry must be an object.')
    for (const key of Object.keys(row)) if (!['id', 'name', 'missing', ...kinds].includes(key)) throw new Error(`Unknown field ${key} in an import entry.`)
    if (typeof row.id !== 'string' || !byId.has(row.id)) throw new Error(`Unknown exercise id: ${String(row.id)}`)
    if (seen.has(row.id)) throw new Error(`Duplicate exercise id: ${row.id}`)
    seen.add(row.id)
    const ex = byId.get(row.id)
    for (const kind of kinds) {
      const value = row[kind]
      if (value == null || value === '') continue
      const url = httpsUrl(value, `${row.id}.${kind}`)
      const target = fileFor(ex, kind)
      if (!target) throw new Error(`${row.id} has no catalog filename for ${kind}; update the exercise data first.`)
      if (exists(target) || existsSync(target)) throw new Error(`${row.id}.${kind} already exists at ${target}; it was left unchanged.`)
      jobs.push({ id: row.id, kind, url, target })
    }
  }
  return jobs
}

async function responseFor(url) {
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000) })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location || redirects === 5) throw new Error('too many or invalid redirects')
      url = httpsUrl(new URL(location, url).href, 'redirect URL')
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`HTTP ${response.status}`)
    }
    return response
  }
  throw new Error('too many redirects')
}

async function readImage(job) {
  const response = await responseFor(job.url)
  const maxBytes = job.kind === 'img' ? 10 * 1024 * 1024 : 20 * 1024 * 1024
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel()
    throw new Error(`file exceeds ${maxBytes / 1024 / 1024} MB`)
  }
  if (!response.body) throw new Error('empty response')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new Error(`file exceeds ${maxBytes / 1024 / 1024} MB`)
    }
    chunks.push(Buffer.from(value))
  }
  const bytes = Buffer.concat(chunks)
  const valid = job.kind === 'img'
    ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : /^(GIF87a|GIF89a)$/.test(bytes.subarray(0, 6).toString('ascii'))
  if (!valid) throw new Error(job.kind === 'img' ? 'link did not return a JPEG image' : 'link did not return a GIF')
  return bytes
}

async function importFile(file) {
  const jobs = importJobs(file)
  if (!jobs.length) {
    console.error('No media links supplied; nothing to import.')
    return
  }
  let failed = false
  for (const job of jobs) {
    try {
      const bytes = await readImage(job)
      mkdirSync(dirname(job.target), { recursive: true })
      const tmp = `${job.target}.${process.pid}.${randomUUID()}.tmp`
      try {
        writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o644 })
        linkSync(tmp, job.target) // Atomic and refuses to replace an existing exercise image.
      } finally {
        try { unlinkSync(tmp) } catch { /* link failed before the temp file was created */ }
      }
      console.error(`Added ${job.id} ${job.kind} → ${job.target.slice(mediaDir.length + 1)}`)
    } catch (error) {
      failed = true
      console.error(`Failed ${job.id} ${job.kind}: ${error.message}`)
    }
  }
  if (failed) process.exitCode = 1
}

const [command, file] = process.argv.slice(2)
try {
  if (command === 'list' && !file) list()
  else if (command === 'import' && file) await importFile(file)
  else {
    console.error('Usage:\n  node scripts/exercise-media.mjs list > media-links.json\n  node scripts/exercise-media.mjs import media-links.json')
    process.exitCode = 2
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
