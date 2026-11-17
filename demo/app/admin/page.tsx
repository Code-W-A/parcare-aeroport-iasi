"use client"

import { useEffect, useRef, useState } from "react"
import { ArrowDownRight, ArrowUpRight, Bell, CalendarDays, CarFront, ChevronRight, ClipboardList, Download, Gift, LayoutDashboard, LogOut, Menu, Plus, Search, X } from "lucide-react"
import { BookingDialog, formatTime } from "./booking-dialog"
import { Loyalty } from "./loyalty"
import { firebaseMode } from "../../lib/foundation"
import { StaffAccess } from "./staff-access"
import { DemoLogin } from "./demo-login"
import { activityLabel, bookingStates, currency, dateLabel, exportReport, localTime, minutesUntil, payments, seed, shiftDay, sources, status, type Booking } from "./data"

const sections = [
  { key: "today", label: "Azi", icon: LayoutDashboard },
  { key: "bookings", label: "Rezervări", icon: ClipboardList },
  { key: "reports", label: "Rapoarte", icon: CalendarDays },
  { key: "loyalty", label: "Fidelizare", icon: Gift },
  { key: "alerts", label: "Alerte", icon: Bell },
] as const

type Section = typeof sections[number]["key"]
type Movement = "arrival" | "departure"
type Alert = { booking: Booking; label: string; time: string; field: Movement; overdue: boolean }
type BookingNotice = { bookingId: string; time: string; read: boolean }
const emptyFilters = { search: "", from: "", to: "", status: "", payment: "", source: "" }
const movementLabels = { arrival: "Confirmă sosirea", departure: "Confirmă plecarea" }

function needsConfirmation(booking: Booking, field: Movement) {
  return !booking.cancelled && (field === "arrival" ? !booking.arrivedAt : Boolean(booking.arrivedAt && !booking.departedAt))
}

function delayLabel(field: Movement, minutes: number) {
  return `${field === "arrival" ? "Sosire întârziată" : "Plecare întârziată"} cu ${Math.abs(minutes)} min`
}
const descriptions: Record<Section, string> = {
  today: "Sosirile și plecările programate pentru ziua de azi.",
  bookings: "Consultă, adaugă și actualizează rezervările parcării.",
  reports: "Consultă programul de intrări și ieșiri pe intervalul selectat.",
  loyalty: "Urmărește clienții recurenți și gestionează beneficiile lor.",
  alerts: "Urmărește rezervările noi și sosirile sau plecările de verificat.",
}

function TimeList({ bookings, field, empty, now, parked, onOpen, onConfirm }: {
  bookings: Booking[]; field: Movement; empty: string; now: string; parked?: boolean
  onOpen: (id: string) => void; onConfirm: (booking: Booking, field: Movement) => void
}) {
  if (!bookings.length) return <p className="empty">{empty}</p>
  return <ul className="time-list">{bookings.map(booking => {
    const time = booking[field]
    const actionable = needsConfirmation(booking, field)
    const minutes = minutesUntil(time, now)
    return <li className="movement-row" key={booking.id}>
      <button className="time-row" onClick={() => onOpen(booking.id)}>
        <span className="movement-time">{time.startsWith(now.slice(0, 10)) ? time.slice(11) : formatTime(time)}</span>
        <span className="row-client"><strong>{booking.name}</strong><span>{booking.plate}</span>
          {parked && <span>Sosire efectivă {formatTime(booking.arrivedAt)}</span>}
          {parked && <span>Plecare programată {formatTime(booking.departure)}</span>}
          {actionable && minutes < 0 && <span className="late-label">{delayLabel(field, minutes)}</span>}
        </span>
        <span className="pill" data-state={status(booking)}>{status(booking)}</span>
        <ChevronRight size={16} className="muted" aria-hidden="true" />
      </button>
      {actionable && <button className="button secondary movement-action" onClick={() => onConfirm(booking, field)}>{movementLabels[field]}</button>}
    </li>
  })}</ul>
}

export default function AdminPage() {
  return firebaseMode ? <StaffAccess /> : <DemoAdminPage />
}

function DemoAdminPage() {
  const [now, setNow] = useState("")
  const [bookings, setBookings] = useState<Booking[]>([])
  const [section, setSection] = useState<Section>("today")
  const [session, setSession] = useState(false)
  const [bookingNotices, setBookingNotices] = useState<BookingNotice[]>([])
  const [menu, setMenu] = useState(false)
  const [selection, setSelection] = useState<string | null>(null)
  const [filters, setFilters] = useState(emptyFilters)
  const [range, setRange] = useState({ from: "", to: "" })
  const [reportPreset, setReportPreset] = useState<"today" | "tomorrow" | "custom">("today")
  const [reportType, setReportType] = useState("Toate")
  const [notice, setNotice] = useState("")
  const trigger = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const time = localTime()
    setNow(time)
    setBookings(seed(time))
    setBookingNotices([
      { bookingId: "IAS-103", time, read: false },
      { bookingId: "IAS-108", time, read: false },
    ])
    const timer = window.setInterval(() => setNow(localTime()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const day = now.slice(0, 10)
  const unreadNotices = bookingNotices.filter(item => !item.read).length
  const active = bookings.filter(booking => !booking.cancelled)
  function schedule(field: Movement) {
    return active.filter(booking => booking[field].startsWith(day) || (needsConfirmation(booking, field) && booking[field] < now))
      .sort((a, b) => {
        const overdue = (booking: Booking) => Number(needsConfirmation(booking, field) && booking[field] < now)
        return overdue(b) - overdue(a) || a[field].localeCompare(b[field])
      })
  }
  const arrivals = schedule("arrival")
  const departures = schedule("departure")
  const parked = active.filter(booking => booking.arrivedAt && !booking.departedAt)
    .sort((a, b) => a.departure.localeCompare(b.departure))
  const alerts = active.flatMap<Alert>(booking => {
    const field = booking.arrivedAt ? "departure" : "arrival"
    if (!needsConfirmation(booking, field)) return []
    const time = booking[field]
    const minutes = minutesUntil(time, now)
    if (minutes < 0) return [{ booking, field, time, overdue: true, label: delayLabel(field, minutes) }]
    if (field === "departure" && minutes <= 30) return [{ booking, field, time, overdue: false, label: minutes === 0 ? "Plecare programată acum" : `Plecare în ${minutes} min` }]
    return []
  }).sort((a, b) => a.time.localeCompare(b.time))
  const query = filters.search.trim().toLocaleLowerCase("ro")
  const validFilters = !filters.from || !filters.to || filters.from <= filters.to
  const filtered = validFilters ? bookings.filter(booking => {
    const matchesQuery = [booking.name, booking.phone, booking.plate, booking.id]
      .some(value => value.toLocaleLowerCase("ro").includes(query))
    const matchesRange = [booking.arrival, booking.departure].some(value => {
      const date = value.slice(0, 10)
      return (!filters.from || date >= filters.from) && (!filters.to || date <= filters.to)
    })
    return matchesQuery && matchesRange && (!filters.payment || booking.payment === filters.payment)
      && (!filters.status || status(booking) === filters.status) && (!filters.source || booking.source === filters.source)
  }).sort((a, b) => b.arrival.localeCompare(a.arrival)) : []

  const reportDay = day && reportPreset === "tomorrow" ? shiftDay(day, 1) : day
  const reportRange = reportPreset === "custom" ? range : { from: reportDay, to: reportDay }
  const validRange = Boolean(reportRange.from && reportRange.to && reportRange.from <= reportRange.to)
  const report = validRange ? active.flatMap(booking => [
    { booking, kind: "Sosire", time: booking.arrival },
    { booking, kind: "Plecare", time: booking.departure },
  ]).filter(({ time, kind }) => time.slice(0, 10) >= reportRange.from && time.slice(0, 10) <= reportRange.to && (reportType === "Toate" || kind === reportType))
    .sort((a, b) => a.time.localeCompare(b.time)) : []
  const selected = bookings.find(booking => booking.id === selection)
  const open = (id: string) => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setNotice("")
    setSelection(id)
  }
  function closeBooking() {
    setSelection(null)
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }))
  }
  const navigate = (key: Section) => { setSection(key); setMenu(false); setNotice("") }

  function saveBooking(booking: Booking, showDetails: boolean) {
    const previous = bookings.find(item => item.id === booking.id)
    const label = activityLabel(previous, booking)
    const updated = { ...booking, activity: [{ label, time: localTime() }, ...(previous?.activity ?? [])] }
    setBookings(current => previous ? current.map(item => item.id === booking.id ? updated : item) : [...current, updated])
    if (!previous) setBookingNotices(current => [{ bookingId: booking.id, time: localTime(), read: false }, ...current])
    if (showDetails) setSelection(booking.id)
    setNotice(`${label} · ${booking.id}`)
  }

  function confirmMovement(booking: Booking, field: Movement) {
    if (!needsConfirmation(booking, field)) return
    const time = localTime()
    saveBooking(field === "arrival" ? { ...booking, arrivedAt: time } : { ...booking, departedAt: time }, false)
  }

  if (!now) return <main className="login"><p>Se încarcă panoul…</p></main>
  if (!session) return <DemoLogin onLogin={() => { setSession(true); navigate("today") }} />

  return (
    <div className="shell">
      {menu && <button className="scrim" aria-label="Închide meniul" onClick={() => setMenu(false)} />}
      <aside className={menu ? "sidebar open" : "sidebar"}>
        <div className="brand">
          <span className="brand-icon"><CarFront size={23} /></span>
          <div><strong>Parcare Aeroport Iași</strong><small>Administrare</small></div>
          <button className="icon-button mobile-only" aria-label="Închide meniul" onClick={() => setMenu(false)}><X size={19} /></button>
        </div>
        <nav aria-label="Panou de administrare">
          {sections.map(({ key, label, icon: Icon }) => (
            <button key={key} aria-current={section === key ? "page" : undefined} onClick={() => navigate(key)}>
              <Icon size={19} />{label}
              {key === "alerts" && alerts.length + unreadNotices > 0 && <span className="nav-count">{alerts.length + unreadNotices}</span>}
            </button>
          ))}
        </nav>
        <div className="account">
          <div className="avatar">OD</div><div><strong>Operator demo</strong><small>Acces demonstrativ</small></div>
          <button className="icon-button" aria-label="Deconectare" title="Deconectare" onClick={() => { setSelection(null); setMenu(false); setSession(false) }}><LogOut size={18} /></button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button className="icon-button mobile-only" aria-label="Deschide meniul" aria-expanded={menu} onClick={() => setMenu(true)}><Menu size={22} /></button>
          <span><CalendarDays size={17} />{dateLabel(day)}</span>
          <span className="demo-label"><span className="demo-full">Date demonstrative</span><span className="demo-short">Demo</span></span>
          <button className="icon-button header-bell" aria-label={`Notificări, ${unreadNotices} necitite`} onClick={() => navigate("alerts")}>
            <Bell size={21} />{unreadNotices > 0 && <span className="nav-count">{unreadNotices}</span>}
          </button>
        </header>
        <main className="content">
          <div className="page-title">
            <div><h1>{sections.find(item => item.key === section)?.label}</h1><p>{descriptions[section]}</p></div>
            {(section === "today" || section === "bookings") && <button className="button primary" onClick={() => open("new")}><Plus size={18} /> Rezervare nouă</button>}
          </div>
          {notice && <p className="notice" role="status">{notice}</p>}
          {section === "today" && (
            <>
              <div className="metrics">
                {[
                  { label: "Sosiri azi", number: arrivals.filter(booking => booking.arrival.startsWith(day)).length, icon: ArrowDownRight, color: "blue" },
                  { label: "Plecări azi", number: departures.filter(booking => booking.departure.startsWith(day)).length, icon: ArrowUpRight, color: "violet" },
                  { label: "Mașini în parcare", number: parked.length, icon: CarFront, color: "green" },
                ].map(({ label, number, icon: Icon, color }) => (
                  <div className="panel metric" key={label}><span className={`metric-icon ${color}`}><Icon size={22} /></span><div><span>{label}</span><strong>{number}</strong></div></div>
                ))}
              </div>
              <div className="columns">
                <section className="panel"><h2>Sosiri programate</h2><TimeList bookings={arrivals} field="arrival" empty="Nicio sosire programată." onOpen={open} now={now} onConfirm={confirmMovement} /></section>
                <section className="panel"><h2>Plecări programate</h2><TimeList bookings={departures} field="departure" empty="Nicio plecare programată." onOpen={open} now={now} onConfirm={confirmMovement} /></section>
              </div>
              <section className="panel">
                <div className="panel-heading"><h2>Mașini în parcare</h2><span className="muted">{parked.length} confirmate</span></div>
                <TimeList bookings={parked} field="departure" empty="Nicio mașină în parcare." onOpen={open} now={now} onConfirm={confirmMovement} parked />
              </section>
              {alerts.length > 0 && <button className="button secondary" onClick={() => navigate("alerts")}><Bell size={17} /> Alerte de verificat ({alerts.length})</button>}
            </>
          )}
          {section === "bookings" && (
            <section className="panel">
              <div className="filters">
                <label className="search-field">Caută rezervare<span><Search size={17} /><input value={filters.search} onChange={e => setFilters({ ...filters, search: e.target.value })} placeholder="Nume, telefon, număr auto sau cod" /></span></label>
                <label>Sosire sau plecare de la<input type="date" value={filters.from} onChange={e => setFilters({ ...filters, from: e.target.value })} /></label>
                <label>Până la<input type="date" value={filters.to} onChange={e => setFilters({ ...filters, to: e.target.value })} /></label>
                {([
                  { key: "status", label: "Stare rezervare", options: bookingStates },
                  { key: "payment", label: "Stare plată", options: payments },
                  { key: "source", label: "Sursă", options: sources },
                ] as const).map(({ key, label, options }) => <label key={key}>{label}<select value={filters[key]} onChange={e => setFilters({ ...filters, [key]: e.target.value })}><option value="">Toate</option>{options.map(item => <option key={item}>{item}</option>)}</select></label>)}
              </div>
              <div className="results-bar"><span role="status">{filtered.length} {filtered.length === 1 ? "rezultat" : "rezultate"}</span><button className="button secondary" onClick={() => setFilters(emptyFilters)} disabled={!Object.values(filters).some(Boolean)}>Resetează filtrele</button></div>
              <div className="table-wrap bookings-desktop"><table>
                <thead><tr><th>Client</th><th>Număr auto</th><th>Sosire</th><th>Plecare</th><th>Stare</th><th>Plată</th><th>Sursă</th><th className="booking-action">Detalii</th></tr></thead>
                <tbody>{filtered.map(booking => (
                  <tr key={booking.id}>
                    <td><button className="text-button" onClick={() => open(booking.id)}>{booking.name}</button><small>{booking.id}</small></td>
                    <td><strong>{booking.plate}</strong></td>
                    <td>{dateLabel(booking.arrival)}<small>{booking.arrival.slice(11)}</small></td>
                    <td>{dateLabel(booking.departure)}<small>{booking.departure.slice(11)}</small></td>
                    <td><span className="pill" data-state={status(booking)}>{status(booking)}</span></td>
                    <td><span className="payment-pill" data-payment={booking.payment}>{booking.payment}</span><small>{currency.format(booking.amount)}</small></td>
                    <td>{booking.source}</td>
                    <td className="booking-action">
                      <button
                        className="button secondary"
                        aria-label={`Deschide rezervarea ${booking.id} pentru ${booking.name}`}
                        onClick={() => open(booking.id)}
                      >
                        Deschide <ChevronRight size={15} aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
              <ul className="bookings-mobile">
                {filtered.map(booking => <li key={booking.id}>
                  <div><strong>{booking.plate}</strong><small>{booking.name} · {booking.id}</small></div>
                  <span className="pill" data-state={status(booking)}>{status(booking)}</span>
                  <div><small>Sosire {formatTime(booking.arrival)}</small><small>Plecare {formatTime(booking.departure)}</small></div>
                  <button className="button secondary" aria-label={`Deschide rezervarea ${booking.id} pentru ${booking.name}`} onClick={() => open(booking.id)}>Deschide</button>
                  <span className="payment-pill" data-payment={booking.payment}>{booking.payment}</span>
                </li>)}
              </ul>
              {!validFilters && <p className="empty error">Data de final trebuie să fie egală cu sau ulterioară datei de început.</p>}
              {validFilters && !filtered.length && <p className="empty">{bookings.length ? "Nu există rezervări pentru filtrele selectate." : "Nu există încă rezervări."}</p>}
            </section>
          )}
          {section === "reports" && (
            <section className="panel">
              <div className="report-toolbar">
                <div className="report-filter">
                  <span id="report-period-label">Perioadă</span>
                  <div className="segmented" role="group" aria-labelledby="report-period-label">
                    {([{ key: "today", label: "Azi" }, { key: "tomorrow", label: "Mâine" }, { key: "custom", label: "Interval personalizat" }] as const).map(({ key, label }) =>
                      <button type="button" key={key} aria-pressed={reportPreset === key} onClick={() => {
                        if (key === "custom" && !range.from) setRange({ from: reportDay, to: reportDay })
                        setReportPreset(key)
                      }}>{label}</button>)}
                  </div>
                </div>
                <div className="report-filter">
                  <span id="report-movement-label">Mișcare</span>
                  <div className="segmented" role="group" aria-labelledby="report-movement-label">
                    {([{ value: "Toate", label: "Toate" }, { value: "Sosire", label: "Sosiri" }, { value: "Plecare", label: "Plecări" }] as const).map(({ value, label }) =>
                      <button type="button" key={value} aria-pressed={reportType === value} onClick={() => setReportType(value)}>{label}</button>)}
                  </div>
                </div>
                <button className="button secondary report-export" disabled={!report.length} onClick={() => exportReport(report)}><Download size={17} /> Export CSV</button>
                {reportPreset === "custom" && <div className="report-dates">
                  <label>De la<input type="date" value={range.from} onChange={e => setRange({ ...range, from: e.target.value })} /></label>
                  <label>Până la<input type="date" value={range.to} onChange={e => setRange({ ...range, to: e.target.value })} /></label>
                </div>}
              </div>
              {validRange && <div className="results-bar"><span>{dateLabel(reportRange.from)}{reportRange.from !== reportRange.to && ` – ${dateLabel(reportRange.to)}`}</span><span>{report.filter(row => row.kind === "Sosire").length} sosiri · {report.filter(row => row.kind === "Plecare").length} plecări</span></div>}
              {validRange ? (
                <div className="table-wrap"><table>
                  <thead><tr><th>Tip</th><th>Dată și oră</th><th>Client</th><th>Număr auto</th><th>Stare</th></tr></thead>
                  <tbody>{report.map(({ booking, kind, time }) => <tr key={booking.id + kind}>
                    <td>{kind}</td><td>{dateLabel(time)} · {time.slice(11)}</td><td><button className="text-button" onClick={() => open(booking.id)}>{booking.name}</button></td><td>{booking.plate}</td><td>{status(booking)}</td>
                  </tr>)}</tbody>
                </table></div>
              ) : <p className="empty">Selectează un interval valid.</p>}
              {validRange && !report.length && <p className="empty">Nicio intrare sau ieșire în perioada selectată.</p>}
            </section>
          )}
          <div hidden={section !== "loyalty"}>
            <Loyalty bookings={bookings} onOpen={open} />
          </div>
          {section === "alerts" && (
            <>
            <section className="panel" aria-label="Notificări rezervări noi">
              <div className="panel-heading"><h2>Rezervări noi</h2>
                <button className="button secondary" disabled={!unreadNotices} onClick={() => setBookingNotices(current => current.map(item => ({ ...item, read: true })))}>Marchează toate ca citite</button>
              </div>
              {!bookingNotices.length && <p className="empty">Nicio notificare de rezervare nouă.</p>}
              {bookingNotices.map(item => {
                const booking = bookings.find(booking => booking.id === item.bookingId)
                if (!booking) return null
                return <div className={`movement-row alert-item${item.read ? "" : " unread-notice"}`} key={item.bookingId} data-testid={`booking-notice-${item.bookingId}`}>
                  <button className="alert-row" onClick={() => {
                    setBookingNotices(current => current.map(notice => notice.bookingId === item.bookingId ? { ...notice, read: true } : notice))
                    open(item.bookingId)
                  }}>
                    <span className="metric-icon blue"><Bell size={18} /></span>
                    <span><strong>Rezervare nouă · {booking.source}</strong><small>{booking.id} · {booking.name} · {booking.plate}</small><small>{formatTime(item.time)} · {item.read ? "Citită" : "Necitită"}</small></span>
                    <ChevronRight size={17} className="muted" />
                  </button>
                  {!item.read && <button className="button secondary movement-action" onClick={() => setBookingNotices(current => current.map(notice => notice.bookingId === item.bookingId ? { ...notice, read: true } : notice))}>Marchează citită</button>}
                </div>
              })}
            </section>
            <section className="panel">
              <h2>Alerte operaționale</h2>
              {!alerts.length && <p className="empty">Nicio alertă de verificat.</p>}
              {alerts.map(({ booking, label, time, field, overdue }) => (
                <div className="movement-row alert-item" key={booking.id}>
                  <button className="alert-row" onClick={() => open(booking.id)}>
                    <span className={`metric-icon ${overdue ? "amber" : "blue"}`}><Bell size={18} /></span>
                    <span><strong>{label}</strong><small>{booking.plate} · {booking.name} · {formatTime(time)}</small></span>
                    <ChevronRight size={17} className="muted" />
                  </button>
                  {overdue && <button className="button secondary movement-action" onClick={() => confirmMovement(booking, field)}>{movementLabels[field]}</button>}
                </div>
              ))}
            </section>
            </>
          )}
        </main>
      </div>
      {selection && <BookingDialog key={selection === "new" ? "new" : selected?.id} booking={selected} now={now} notice={notice} onClose={closeBooking} onSave={booking => saveBooking(booking, true)} />}
    </div>
  )
}
