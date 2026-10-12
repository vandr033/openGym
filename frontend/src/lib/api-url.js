import { appBase } from './app-base.js'

let remoteBase = ''

export const setApiBase = base => { remoteBase = base || '' }
export const hasRemoteApi = () => !!remoteBase
export const apiUrl = path => remoteBase ? remoteBase + path : appBase().replace(/\/$/, '') + path
