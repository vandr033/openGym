import { api } from './api.js'

const CACHE = 'gym_collab_session_v1:'

const cacheKey = userId => CACHE + encodeURIComponent(userId)

export function cachedCollabSession(userId) {
  try { return JSON.parse(localStorage.getItem(cacheKey(userId)) || 'null') } catch { return null }
}

export function cacheCollabSession(userId, session) {
  try {
    if (session) localStorage.setItem(cacheKey(userId), JSON.stringify(session))
    else localStorage.removeItem(cacheKey(userId))
  } catch { /* server state remains authoritative when local storage is unavailable */ }
}

export function clearCollabSession(userId) {
  cacheCollabSession(userId, null)
}

export const clientActiveSessionPath = clientId =>
  `/api/v2/clients/${encodeURIComponent(clientId)}/workout-sessions/active`

export async function readClientActiveSession(clientId) {
  return api(clientActiveSessionPath(clientId))
}
