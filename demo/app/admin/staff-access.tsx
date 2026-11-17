'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth'
import { CarFront, Eye, EyeOff } from 'lucide-react'
import { checkStaffSession, staffAuth } from '../../lib/foundation'
import { ConnectedAdmin } from './connected-admin'
import type { StaffSession } from '../../lib/foundation-contracts'

export function StaffAccess() {
  const [session, setSession] = useState<StaffSession | null>(null)
  const [checking, setChecking] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [hasUser, setHasUser] = useState(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  const pending = useRef<{uid: string; request: Promise<void>} | null>(null)

  const refresh = useCallback(async () => {
    const uid = staffAuth().currentUser?.uid
    if (!uid) return
    if (pending.current?.uid === uid) return pending.current.request
    const run = generation.current
    const current = () => mounted.current && run === generation.current && staffAuth().currentUser?.uid === uid
    const request = (async () => {
      try { const next = await checkStaffSession(); if (current()) { setSession(next); setError('') } }
      catch (error) { if (current()) { setSession(null); setError(error instanceof Error ? error.message : 'Acces indisponibil.') } }
      finally { if (current()) setChecking(false) }
    })()
    pending.current = {uid, request}
    try { await request } finally { if (pending.current?.request === request) pending.current = null }
  }, [])
  useEffect(() => {
    mounted.current = true
    let cancelled = false
    let unsubscribe = () => {}
    const check = () => { if (document.visibilityState === 'visible' && staffAuth().currentUser) void refresh() }
    try {
      unsubscribe = onAuthStateChanged(staffAuth(), user => {
        if (cancelled) return
        ++generation.current
        pending.current = null
        setHasUser(!!user)
        if (user) void refresh()
        else { setSession(null); setChecking(false) }
      })
      document.addEventListener('visibilitychange', check)
      window.addEventListener('focus', check)
    } catch (error) { setError(error instanceof Error ? error.message : 'Configurație indisponibilă.'); setChecking(false) }
    return () => { cancelled = true; mounted.current = false; ++generation.current; unsubscribe(); document.removeEventListener('visibilitychange', check); window.removeEventListener('focus', check) }
  }, [refresh])

  if (checking) return <main className="login"><p>Se verifică sesiunea…</p></main>
  if (session) return <ConnectedAdmin session={session} onVerify={refresh} onLogout={() => signOut(staffAuth())} />

  return <main className="login"><form className="panel login-card" onSubmit={async event => {
    event.preventDefault()
    if (!email.trim() || !password) { setError('Completează emailul și parola.'); return }
    setSubmitting(true); setError('')
    try { setChecking(true); await signInWithEmailAndPassword(staffAuth(), email.trim(), password); setPassword('') }
    catch { setChecking(false); setError('Autentificarea a eșuat. Verifică datele și conexiunea.') }
    finally { setSubmitting(false) }
  }}>
    <span className="brand-icon"><img src="/brand-logo.png" alt="Parcare Aeroport Iași" width={40} height={40} /></span><h1>Parcare Aeroport Iași</h1><p>Autentificare personal</p>
    <label>Email<input type="email" autoComplete="username" value={email} disabled={submitting} onChange={e => setEmail(e.target.value)} required /></label>
    <label htmlFor="staff-password">Parolă</label><div className="password-field">
      <input id="staff-password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} disabled={submitting} onChange={e => setPassword(e.target.value)} required />
      <button className="icon-button" type="button" aria-label={showPassword ? 'Ascunde parola' : 'Arată parola'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button>
    </div>
    {error && <p role="alert" className="error">{error}</p>}
    <button className="button primary" disabled={submitting}>{submitting ? 'Se verifică…' : 'Autentificare'}</button>
    {hasUser && <button type="button" className="button secondary" onClick={() => void signOut(staffAuth())}>Folosește alt cont</button>}
  </form></main>
}
