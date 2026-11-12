"use client"

import { useState } from "react"
import { ChevronRight, X } from "lucide-react"
import { formatTime, useModal } from "./booking-dialog"
import { status, type Booking } from "./data"

type Benefit = { points: number; description: string; used: boolean }
const defaultBenefit = { points: 0, description: "", used: false }
const initialBenefits: Record<string, Benefit> = {
  "0700000101": { points: 40, description: "Reducere 10% la următoarea rezervare", used: false },
}

export function Loyalty({ bookings, onOpen }: { bookings: Booking[]; onOpen: (id: string) => void }) {
  const [search, setSearch] = useState("")
  const [phone, setPhone] = useState<string | null>(null)
  const [benefits, setBenefits] = useState(initialBenefits)
  const customers = new Map<string, Booking[]>()
  for (const booking of bookings) {
    const number = booking.phone.replace(/[\s()-]/g, "")
    const history = customers.get(number) ?? []
    history.push(booking)
    customers.set(number, history)
  }
  const recurring = [...customers].filter(([, history]) => history.filter(booking => !booking.cancelled).length >= 2)
  const query = search.trim().toLocaleLowerCase("ro")
  const filtered = recurring.filter(([number, history]) => number.includes(query) || history.some(booking => booking.name.toLocaleLowerCase("ro").includes(query)))
  const history = phone ? customers.get(phone) : undefined
  return (
    <section className="panel">
      <h2>Clienți recurenți</h2>
      <div className="filters"><label className="search-field">Caută client<input value={search} onChange={event => setSearch(event.target.value)} placeholder="Nume sau telefon" /></label></div>
      {!filtered.length && <p className="empty">{recurring.length ? "Niciun client pentru această căutare." : "Nu există încă clienți recurenți."}</p>}
      {filtered.map(([number, history]) => {
        const benefit = benefits[number]
        return <button key={number} className="customer-row" onClick={() => setPhone(number)}>
          <span><strong>{history[0].name}</strong><small>{history.filter(booking => !booking.cancelled).length} rezervări · {number}</small></span>
          <span>{benefit?.description && !benefit.used ? benefit.description : "Fără beneficiu activ"}<small>{benefit?.points ?? 0} puncte</small></span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      })}
      {phone && history && <CustomerDialog history={history} phone={phone} benefit={benefits[phone] ?? defaultBenefit}
        onClose={() => setPhone(null)} onChange={benefit => setBenefits(previous => ({ ...previous, [phone]: benefit }))}
        onOpen={id => { setPhone(null); onOpen(id) }} />}
    </section>
  )
}

function CustomerDialog({ history, phone, benefit, onClose, onChange, onOpen }: {
  history: Booking[]; phone: string; benefit: Benefit; onClose: () => void; onChange: (benefit: Benefit) => void; onOpen: (id: string) => void
}) {
  const dialog = useModal()
  const [notice, setNotice] = useState("")
  return (
    <dialog ref={dialog} className="booking-dialog" aria-labelledby="customer-title" onCancel={event => { event.preventDefault(); onClose() }}>
      <div className="dialog-head"><div><h2 id="customer-title">{history[0].name}</h2><p>{phone}</p></div><button className="icon-button" aria-label="Închide" onClick={onClose}><X size={20} /></button></div>
      <div className="dialog-body detail-sections">
        <section>
          <h3>Beneficiu curent</h3>
          <p>{benefit.description || "Fără beneficiu activ"}{benefit.used && " · Utilizat"}</p>
          <form className="form-grid" onSubmit={event => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            const description = String(data.get("benefit")).trim()
            onChange({ points: Number(data.get("points")), description, used: false })
            setNotice(description ? "Beneficiu acordat în demo." : "Puncte actualizate.")
          }}>
            <label>Puncte<input name="points" type="number" min="0" step="1" required defaultValue={benefit.points} /></label>
            <label>Reducere sau beneficiu<input name="benefit" defaultValue={benefit.description} placeholder="Ex. reducere 10%" /></label>
            <div className="actions">
              <button className="button primary">Salvează beneficiul</button>
              {benefit.description && !benefit.used && <button type="button" className="button secondary" onClick={() => {
                onChange({ ...benefit, used: true })
                setNotice("Beneficiu marcat ca utilizat.")
              }}>Marchează utilizat</button>}
            </div>
          </form>
          {notice && <p role="status" className="notice">{notice}</p>}
        </section>
        <section><h3>Istoric rezervări</h3><ul className="activity-list">{[...history].sort((a, b) => b.arrival.localeCompare(a.arrival)).map(booking =>
          <li key={booking.id}><button className="text-button" onClick={() => onOpen(booking.id)}>{booking.id} · {booking.plate}</button><small>{formatTime(booking.arrival)} · {status(booking)}</small></li>
        )}</ul></section>
      </div>
    </dialog>
  )
}
