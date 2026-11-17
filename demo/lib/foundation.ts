import { getApp, getApps, initializeApp } from 'firebase/app'
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth'
import type { StaffSession } from './foundation-contracts'

export const firebaseMode = process.env.NEXT_PUBLIC_APP_MODE === 'firebase'
const apiBase = process.env.NEXT_PUBLIC_IASI_API_BASE_URL || ''
let auth: Auth | undefined
let metadata: Promise<void> | undefined
export function staffAuth() {
  if (!firebaseMode) throw new Error('Autentificarea Firebase nu este activă.')
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
  if (!projectId || !process.env.NEXT_PUBLIC_FIREBASE_API_KEY) throw new Error('Configurația Firebase este incompletă.')
  if (!auth) {
    const app = getApps().find(app => app.name === 'iasi-admin') || initializeApp({
      projectId, apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY, authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
      appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    }, 'iasi-admin')
    auth = getAuth(getApp(app.name))
    if (process.env.NEXT_PUBLIC_FIREBASE_USE_EMULATORS === 'true' && !auth.emulatorConfig) {
      connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
    }
  }
  return auth
}
export async function checkStaffSession(): Promise<StaffSession> {
  if (!apiBase) throw new Error('API-ul Iași nu este configurat.')
  const user = staffAuth().currentUser
  if (!user) throw new Error('Autentificarea este necesară.')
  if (!metadata) {
    metadata = fetch(`${apiBase}/v1/meta`, {cache:'no-store',signal:AbortSignal.timeout(12_000)}).then(async response => {
      const data = await response.json()
      if (!response.ok || data.projectId !== process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) throw new Error('API-ul și Firebase trebuie să folosească același proiect Iași.')
      if ((data.environment === 'emulator') !== (process.env.NEXT_PUBLIC_FIREBASE_USE_EMULATORS === 'true')) throw new Error('Configurația emulator/cloud nu corespunde.')
    }).catch(error => { metadata = undefined; throw error })
  }
  await metadata
  const token = await user.getIdToken()
  const response = await fetch(`${apiBase}/v1/staff/session`, {headers:{Authorization:`Bearer ${token}`},cache:'no-store',signal:AbortSignal.timeout(12_000)})
  const data = await response.json()
  if (!response.ok) throw new Error(data.message || 'Accesul la administrare nu este disponibil.')
  return data.session
}

export class ApiFailure extends Error {
  constructor(message: string, public status: number) { super(message) }
}
export async function staffRequest<T>(path: string, method = 'GET', body?: unknown, commandKey?: string): Promise<T> {
  const user = staffAuth().currentUser
  if (!user) throw new ApiFailure('Autentificarea este necesară.', 401)
  const token = await user.getIdToken()
  const response = await fetch(`${apiBase}/v1${path}`, { method, cache:'no-store', signal:AbortSignal.timeout(30_000),
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(commandKey?{'Idempotency-Key':commandKey}:{})},body:body===undefined?undefined:JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new ApiFailure(data.message || 'Operațiunea nu a reușit.', response.status)
  return data
}
export async function exportCsv(path: string) {
  const user=staffAuth().currentUser
  if (!user) throw new Error('Autentificarea este necesară.')
  const response=await fetch(`${apiBase}/v1${path}`,{headers:{Authorization:`Bearer ${await user.getIdToken()}`},cache:'no-store'})
  if(!response.ok) throw new Error('Exportul nu a reușit. Reîncearcă.')
  return response.blob()
}
