"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import { X } from "lucide-react"
import { currency, dateLabel, localTime, status, type Booking } from "./data"

const fields = [
  { key: "name", label: "Nume client", type: "text", required: true },
  { key: "phone", label: "Telefon", type: "tel", required: true },
  { key: "plate", label: "Număr auto", type: "text", required: true },
  { key: "flight", label: "Număr zbor", type: "text", required: false },
  { key: "arrival", label: "Sosire programată", type: "datetime-local", required: true },
  { key: "departure", label: "Plecare programată", type: "datetime-local", required: true },
  { key: "amount", label: "Sumă (lei)", type: "number", required: true },
] as const

export function formatTime(value?: string) {
  return value ? `${dateLabel(value)} · ${value.slice(11)}` : "—"
}

export function useModal() {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  return dialog
}

export function BookingDialog({ booking, now, notice, onClose, onSave }: {
  booking?: Booking
  now: string
  notice: string
  onClose: () => void
  onSave: (booking: Booking) => void
}) {
  const dialog = useModal()
  const [editing, setEditing] = useState(!booking)
  const [confirmation, setConfirmation] = useState<"cancel" | "close" | "discard" | null>(null)
  const [initial, setInitial] = useState(() => formValues(booking, now))
  const [values, setValues] = useState(initial)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saveError, setSaveError] = useState("")
  const dirty = editing && fields.some(({ key }) => initial[key] !== values[key])

  function requestClose() {
    if (confirmation) setConfirmation(null)
    else if (dirty) setConfirmation("close")
    else onClose()
  }

  function edit() {
    const next = formValues(booking, now)
    setInitial(next)
    setValues(next)
    setErrors({})
    setSaveError("")
    setEditing(true)
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const value = (key: string) => String(data.get(key) ?? "").trim()
    const clean = {
      name: value("name"), phone: value("phone"), plate: value("plate").toUpperCase(),
      flight: value("flight"), arrival: value("arrival"), departure: value("departure"), amount: Number(value("amount")),
    }
    const issues: Record<string, string> = {}
    for (const field of fields) {
      if (field.required && !value(field.key)) issues[field.key] = "Completează acest câmp."
    }
    if (!issues.departure && clean.arrival && clean.departure <= clean.arrival) {
      issues.departure = "Plecarea trebuie să fie după sosire."
    }
    if (value("amount") && (!Number.isFinite(clean.amount) || clean.amount < 0 || !/^\d+(\.\d{1,2})?$/.test(value("amount")))) {
      issues.amount = "Introdu o sumă pozitivă sau zero, cu cel mult două zecimale."
    }
    setErrors(issues)
    const first = Object.keys(issues)[0]
    if (first) {
      const input = event.currentTarget.elements.namedItem(first)
      if (input instanceof HTMLInputElement) input.focus()
      return
    }
    try {
      onSave({
        ...booking, ...clean,
        id: booking?.id ?? `IAS-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        source: booking?.source ?? "Manuală", payment: booking?.payment ?? "Neachitat",
      })
      setSaveError("")
      setEditing(false)
    } catch {
      setSaveError("Salvarea a eșuat. Datele introduse sunt păstrate. Încearcă din nou.")
    }
  }

  const activity = booking ? [
    ...(booking.arrivedAt && !booking.activity?.some(item => item.label === "Sosire înregistrată") ? [{ label: "Sosire înregistrată", time: booking.arrivedAt }] : []),
    ...(booking.departedAt && !booking.activity?.some(item => item.label === "Plecare înregistrată") ? [{ label: "Plecare înregistrată", time: booking.departedAt }] : []),
    ...(booking.activity ?? []),
  ].sort((a, b) => b.time.localeCompare(a.time)) : []

  return (
    <dialog ref={dialog} className="booking-dialog" aria-labelledby="dialog-title" onCancel={event => { event.preventDefault(); requestClose() }}>
      <div className="dialog-head">
        <div>
          <h2 id="dialog-title">{booking ? (editing ? "Editează rezervarea" : booking.name) : "Rezervare nouă"}</h2>
          {booking && <div className="booking-meta"><strong>{booking.id} · {booking.plate}</strong><span className="pill" data-state={status(booking)}>{status(booking)}</span></div>}
        </div>
        <button className="icon-button" aria-label="Închide" onClick={requestClose}><X size={20} /></button>
      </div>
      {confirmation ? (
        <div className="dialog-body">
          <h3>{confirmation === "cancel" ? "Anulezi rezervarea?" : "Renunți la modificări?"}</h3>
          <p>{confirmation === "cancel" ? "Rezervarea va rămâne în listă cu starea Anulată." : "Modificările nesalvate se vor pierde."}</p>
          {confirmation === "cancel" && booking?.payment === "Achitat online" && <p>Plata online rămâne în istoric. În demo nu se efectuează rambursări.</p>}
          <div className="actions">
            <button className="button secondary" autoFocus onClick={() => setConfirmation(null)}>Înapoi</button>
            <button className="button danger" onClick={() => {
              if (confirmation === "cancel" && booking) onSave({ ...booking, cancelled: true })
              if (confirmation === "close") onClose()
              if (confirmation === "discard") setEditing(false)
              setConfirmation(null)
            }}>{confirmation === "cancel" ? "Confirmă anularea" : "Renunță la modificări"}</button>
          </div>
        </div>
      ) : editing ? (
        <form noValidate onSubmit={save} className="dialog-body">
          <p className="muted">Câmpurile cu * sunt obligatorii.</p>
          <div className="form-grid">
            {fields.map(({ key, label, type, required }) => (
              <label key={key}>
                {label}{required ? " *" : ""}
                <input name={key} type={type} required={required} defaultValue={values[key]}
                  readOnly={key === "amount" && booking?.payment === "Achitat online"}
                  min={key === "amount" ? 0 : undefined} step={key === "amount" ? ".01" : undefined}
                  aria-invalid={Boolean(errors[key])} aria-describedby={errors[key] ? `error-${key}` : undefined}
                  onInput={event => {
                    const value = event.currentTarget.value
                    setValues(previous => ({ ...previous, [key]: value }))
                    setErrors(previous => ({ ...previous, [key]: "" }))
                  }} />
                {errors[key] && <small className="error" role="alert" id={`error-${key}`}>{errors[key]}</small>}
              </label>
            ))}
          </div>
          {saveError && <p role="alert" className="error">{saveError}</p>}
          <div className="actions">
            <button type="button" className="button secondary" onClick={() => {
              if (!booking) requestClose()
              else if (dirty) setConfirmation("discard")
              else setEditing(false)
            }}>Renunță</button>
            <button className="button primary">Salvează</button>
          </div>
        </form>
      ) : booking && (
        <>
          <div className="dialog-body detail-sections">
            {notice && <p className="notice" role="status">{notice}</p>}
            <section><h3>Client și mașină</h3><dl className="form-grid details">
              <div><dt>Client</dt><dd>{booking.name}</dd></div>
              <div><dt>Telefon</dt><dd>{booking.phone}</dd></div>
              <div><dt>Număr auto</dt><dd>{booking.plate}</dd></div>
              <div><dt>Sursă</dt><dd>{booking.source}</dd></div>
            </dl></section>
            <section><h3>Program și zbor</h3><dl className="form-grid details">
              <div><dt>Sosire programată</dt><dd>{formatTime(booking.arrival)}</dd></div>
              <div><dt>Sosire efectivă</dt><dd>{formatTime(booking.arrivedAt)}</dd></div>
              <div><dt>Plecare programată</dt><dd>{formatTime(booking.departure)}</dd></div>
              <div><dt>Plecare efectivă</dt><dd>{formatTime(booking.departedAt)}</dd></div>
              <div><dt>Zbor</dt><dd>{booking.flight || "—"}</dd></div>
            </dl></section>
            <section><h3>Plată</h3><p><span className="payment-pill" data-payment={booking.payment}>{booking.payment}</span> <strong>{currency.format(booking.amount)}</strong></p></section>
            <section><h3>Activitate</h3>
              {activity.length ? <ul className="activity-list">{activity.map(({ label, time }, index) => <li key={index}><span>{label}</span><small>{formatTime(time)}</small></li>)}</ul> : <p className="muted">Nicio acțiune înregistrată.</p>}
            </section>
          </div>
          {!booking.cancelled && <div className="actions dialog-footer">
            <button className="button secondary" onClick={edit}>Editează</button>
            {!booking.arrivedAt && <button className="button primary" onClick={() => onSave({ ...booking, arrivedAt: localTime() })}>Confirmă sosirea</button>}
            {booking.arrivedAt && !booking.departedAt && <button className="button primary" onClick={() => onSave({ ...booking, departedAt: localTime() })}>Confirmă plecarea</button>}
            {booking.payment === "Neachitat" && <button className="button secondary" onClick={() => onSave({ ...booking, payment: "Achitat la locație" })}>Marchează achitat la locație</button>}
            {!booking.arrivedAt && <button className="button danger" onClick={() => setConfirmation("cancel")}>Anulează rezervarea</button>}
          </div>}
        </>
      )}
    </dialog>
  )
}

function formValues(booking: Booking | undefined, now: string) {
  return {
    name: booking?.name ?? "", phone: booking?.phone ?? "", plate: booking?.plate ?? "",
    flight: booking?.flight ?? "", arrival: booking?.arrival ?? now, departure: booking?.departure ?? "",
    amount: booking ? String(booking.amount) : "",
  }
}
