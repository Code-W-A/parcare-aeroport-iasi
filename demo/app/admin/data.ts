export type Booking = {
  id: string
  name: string
  phone: string
  plate: string
  arrival: string
  departure: string
  flight: string
  source: "Manuală" | "Aplicație" | "Site"
  payment: "Neachitat" | "Achitat online" | "Achitat la locație"
  amount: number
  arrivedAt?: string
  departedAt?: string
  cancelled?: boolean
  activity?: { label: string; time: string }[]
}

export const payments: Booking["payment"][] = ["Neachitat", "Achitat online", "Achitat la locație"]
export const currency = new Intl.NumberFormat("ro-RO", { style: "currency", currency: "RON" })

export function localTime(date = new Date()) {
  const format = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Bucharest", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  })
  return format.format(date).replace(" ", "T")
}

export function dateLabel(date: string) {
  const [year, month, day] = date.slice(0, 10).split("-")
  return `${day}.${month}.${year}`
}

export function status(booking: Booking) {
  if (booking.cancelled) return "Anulată"
  if (booking.departedAt) return "Plecat"
  if (booking.arrivedAt) return "În parcare"
  return "Programată"
}

export const bookingStates = ["Programată", "În parcare", "Plecat", "Anulată"]
export const sources: Booking["source"][] = ["Manuală", "Aplicație", "Site"]

export function shiftDay(day: string, offset: number) {
  const date = new Date(day + "T00:00:00Z")
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

export function minutesUntil(time: string, now: string) {
  return (Date.parse(time + "Z") - Date.parse(now + "Z")) / 60_000
}

export function activityLabel(previous: Booking | undefined, booking: Booking) {
  if (!previous) return "Rezervare creată"
  if (booking.cancelled && !previous.cancelled) return "Rezervare anulată"
  if (booking.arrivedAt && !previous.arrivedAt) return "Sosire înregistrată"
  if (booking.departedAt && !previous.departedAt) return "Plecare înregistrată"
  if (booking.payment !== previous.payment) return "Plată la locație înregistrată"
  return "Rezervare actualizată"
}

export function seed(now: string): Booking[] {
  const day = now.slice(0, 10)
  const [year, month, date] = day.split("-").map(Number)
  const at = (offset: number, time: string) =>
    new Date(Date.UTC(year, month - 1, date + offset)).toISOString().slice(0, 10) + "T" + time
  const nextDeparture = new Date(Date.parse(now + "Z") + 20 * 60_000).toISOString().slice(0, 16)
  return [
    { id: "IAS-108", name: "Ana Marin", phone: "0700000108", plate: "IS 28 DEM", arrival: at(-2, "10:30"), departure: nextDeparture, flight: "", source: "Aplicație", payment: "Achitat online", amount: 120, arrivedAt: at(-2, "10:35") },
    { id: "IAS-109", name: "Mihai Rusu", phone: "0700000109", plate: "IS 29 DEM", arrival: at(1, "12:30"), departure: at(4, "11:00"), flight: "", source: "Manuală", payment: "Neachitat", amount: 150, cancelled: true },
    { id: "IAS-101", name: "Andrei Ionescu", phone: "0700000101", plate: "IS 24 DEM", arrival: at(0, "08:30"), departure: at(3, "15:00"), flight: "RO 701", source: "Aplicație", payment: "Achitat online", amount: 150, arrivedAt: at(0, "08:25") },
    { id: "IAS-102", name: "Maria Dumitrescu", phone: "0700000102", plate: "IS 18 DEM", arrival: at(0, "12:15"), departure: at(4, "18:00"), flight: "W4 3651", source: "Manuală", payment: "Neachitat", amount: 200 },
    { id: "IAS-103", name: "Vlad Stan", phone: "0700000103", plate: "NT 43 DEM", arrival: at(0, "17:45"), departure: at(1, "21:00"), flight: "FR 3109", source: "Site", payment: "Neachitat", amount: 100 },
    { id: "IAS-104", name: "Elena Matei", phone: "0700000104", plate: "IS 09 DEM", arrival: at(-3, "09:30"), departure: at(0, "14:30"), flight: "RO 707", source: "Aplicație", payment: "Achitat online", amount: 150, arrivedAt: at(-3, "09:42") },
    { id: "IAS-105", name: "Andrei Ionescu", phone: "0700000101", plate: "IS 24 DEM", arrival: at(-8, "10:00"), departure: at(0, "07:45"), flight: "", source: "Manuală", payment: "Achitat la locație", amount: 400, arrivedAt: at(-8, "09:54"), departedAt: at(0, "07:38") },
    { id: "IAS-107", name: "Ioana Popa", phone: "0700000107", plate: "IS 62 DEM", arrival: at(-1, "19:00"), departure: at(2, "10:30"), flight: "", source: "Manuală", payment: "Neachitat", amount: 150 },
    { id: "IAS-106", name: "Maria Dumitrescu", phone: "0700000102", plate: "IS 18 DEM", arrival: at(-5, "08:00"), departure: at(-2, "10:30"), flight: "", source: "Manuală", payment: "Achitat la locație", amount: 150, arrivedAt: at(-5, "07:50"), departedAt: at(-2, "10:42") },
  ]
}

export function exportReport(rows: { booking: Booking; time: string; kind: string }[]) {
  const escape = (value: string) => {
    const safe = /^[\s]*[=+\-@\t\r\n]/.test(value) ? "'" + value : value
    return '"' + safe.replaceAll('"', '""') + '"'
  }
  const values = [["Tip", "Data și ora", "Cod", "Client", "Număr auto", "Stare"], ...rows.map(({ booking, time, kind }) =>
    [kind, time.replace("T", " "), booking.id, booking.name, booking.plate, status(booking)])]
  const url = URL.createObjectURL(new Blob(["\uFEFF" + values.map(row => row.map(escape).join(";")).join("\r\n")], { type: "text/csv;charset=utf-8" }))
  const link = document.createElement("a")
  link.href = url
  link.download = "raport-parcare-iasi.csv"
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
