"use client"

import { useState, type FormEvent } from "react"
import { CarFront, Eye, EyeOff } from "lucide-react"

// Public fictional credentials for this frontend-only demo, not an authentication boundary.
const demoEmail = "operator@example.com"
const demoPassword = "Demo123!"

export function DemoLogin({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState("")

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!email.trim() || !password) {
      setError("Completează emailul și parola.")
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Introdu o adresă de email validă.")
      return
    }
    if (email.trim().toLowerCase() !== demoEmail || password !== demoPassword) {
      setError("Emailul sau parola demo sunt incorecte.")
      return
    }
    onLogin()
  }

  return (
    <main className="login">
      <form className="panel login-card" noValidate onSubmit={submit}>
        <span className="brand-icon"><img src="/brand-logo.png" alt="Parcare Aeroport Iași" width={40} height={40} /></span>
        <h1>Parcare Aeroport Iași</h1>
        <p>Autentificare în panoul de administrare</p>
        <div className="notice"><strong>Cont demonstrativ</strong><small>Acces simulat, cu date fictive.</small><small>Email: {demoEmail}</small><small>Parolă: {demoPassword}</small></div>
        <label>Email<input name="email" type="email" autoComplete="username" required value={email}
          aria-invalid={Boolean(error)} aria-describedby={error ? "login-error" : undefined}
          onChange={event => { setEmail(event.target.value); setError("") }} /></label>
        <label htmlFor="demo-password">Parolă</label>
        <div className="password-field">
          <input id="demo-password" name="password" type={visible ? "text" : "password"} autoComplete="current-password" required value={password}
            aria-invalid={Boolean(error)} aria-describedby={error ? "login-error" : undefined}
            onChange={event => { setPassword(event.target.value); setError("") }} />
          <button type="button" className="icon-button" aria-label={visible ? "Ascunde parola" : "Arată parola"} aria-pressed={visible} onClick={() => setVisible(!visible)}>
            {visible ? <EyeOff size={19} /> : <Eye size={19} />}
          </button>
        </div>
        {error && <p id="login-error" className="error" role="alert">{error}</p>}
        <button className="button primary" type="submit">Autentificare</button>
      </form>
    </main>
  )
}
