"use client";
import { useEffect, useRef, useState } from "react";
import { Bell, CarFront, LogOut, Menu, Plus, RefreshCw, X } from "lucide-react";
import {
  clearAdminCache,
  invalidateAdmin,
  useAdminResource,
} from "../../lib/admin-cache";
import {
  useOperations,
  useStaffInbox,
  useStaffNotifications,
} from "../../lib/admin-live";
import { exportCsv, staffRequest } from "../../lib/foundation";
import type {
  AuditRecord,
  BookingConfig,
  BookingInput,
  BookingRecord,
  LoyaltyRecord,
  Page,
  ReportMovement,
  StaffSession,
} from "../../lib/foundation-contracts";
import { currency, localTime, shiftDay } from "./data";
import { useModal } from "./booking-dialog";
const sections = [
  ["today", "Azi"],
  ["bookings", "Rezervări"],
  ["reports", "Rapoarte"],
  ["loyalty", "Fidelizare"],
  ["alerts", "Alerte"],
  ["settings", "Setări"],
] as const;
const bookingLabels = {
  requested: "Cerere nouă",
  confirmed: "Confirmată",
  cancelled: "Anulată",
};
const movementLabels = {
  waiting: "Programată",
  parked: "În parcare",
  departed: "Plecat",
};
const paymentLabels = {
  unpaid: "Neachitat",
  paid_at_site: "Achitat la locație",
  paid_online: "Achitat online",
};
const label = (b: BookingRecord) =>
  b.bookingStatus === "confirmed"
    ? movementLabels[b.movementStatus]
    : bookingLabels[b.bookingStatus];
const when = (s: string | null) => (s ? s.replace("T", " · ") : "—");
const queryString = (params: Record<string, string>) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
function useCommand() {
  const keys = useRef(new Map<string, string>());
  return async <T,>(path: string, body: unknown, method = "POST") => {
    const fingerprint = JSON.stringify([path, body]);
    let key = keys.current.get(fingerprint);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(fingerprint, key);
    }
    return staffRequest<T>(path, method, body, key);
  };
}
export function ConnectedAdmin({
  session,
  onLogout,
  onVerify,
}: {
  session: StaffSession;
  onLogout: () => Promise<void>;
  onVerify: () => Promise<void>;
}) {
  const [section, setSection] = useState("today"),
    [menu, setMenu] = useState(false),
    [now, setNow] = useState(() => localTime()),
    [selection, setSelection] = useState<BookingRecord | "new" | null>(null);
  const [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [search, setSearch] = useState(""),
    [debounced, setDebounced] = useState(""),
    [filters, setFilters] = useState({
      status: "",
      payment: "",
      source: "",
      from: "",
      to: "",
    }),
    [cursor, setCursor] = useState(""),
    [pages, setPages] = useState<BookingRecord[]>([]);
  const [range, setRange] = useState({
      from: now.slice(0, 10),
      to: now.slice(0, 10),
      kind: "",
    }),
    [reportCursor, setReportCursor] = useState(""),
    [reportPages, setReportPages] = useState<ReportMovement[]>([]);
  const [customerSearch, setCustomerSearch] = useState(""),
    [customerQuery, setCustomerQuery] = useState("");
  const [customerCursor, setCustomerCursor] = useState(""),
    [customerPages, setCustomerPages] = useState<LoyaltyRecord[]>([]),
    [customer, setCustomer] = useState<LoyaltyRecord | null>(null);
  const day = now.slice(0, 10),
    live = useOperations(section === "today" || section === "alerts", day),
    notifications = useStaffNotifications(),
    command = useCommand();
  useEffect(() => {
    if (notifications.denied || live.error === "Accesul nu mai este activ.")
      void onVerify();
  }, [notifications.denied, live.error, onVerify]);
  useEffect(() => {
    const timer = setInterval(() => setNow(localTime()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);
  const filterKey = queryString({ ...filters, search: debounced });
  useEffect(() => {
    setCursor("");
    setPages([]);
  }, [filterKey]);
  const bookings = useAdminResource<Page<BookingRecord>>(
    section === "bookings"
      ? `/admin/bookings/search?${filterKey}&cursor=${encodeURIComponent(cursor)}`
      : null,
  );
  useEffect(() => {
    if (bookings.data)
      setPages((old) =>
        cursor ? merge(old, bookings.data!.items) : bookings.data!.items,
      );
  }, [bookings.data, cursor]);
  const reportKey = queryString(range);
  useEffect(() => {
    setReportCursor("");
    setReportPages([]);
  }, [reportKey]);
  const report = useAdminResource<Page<ReportMovement>>(
    section === "reports"
      ? `/admin/reports?${reportKey}&cursor=${encodeURIComponent(reportCursor)}`
      : null,
    120_000,
  );
  useEffect(() => {
    if (report.data)
      setReportPages((old) =>
        reportCursor ? merge(old, report.data!.items) : report.data!.items,
      );
  }, [report.data, reportCursor]);
  useEffect(() => {
    const t = setTimeout(() => {
      setCustomerQuery(customerSearch.trim());
      setCustomerCursor("");
      setCustomerPages([]);
    }, 350);
    return () => clearTimeout(t);
  }, [customerSearch]);
  const customers = useAdminResource<Page<LoyaltyRecord>>(
    section === "loyalty"
      ? `/admin/customers?search=${encodeURIComponent(customerQuery)}&cursor=${encodeURIComponent(customerCursor)}`
      : null,
  );
  useEffect(() => {
    if (customers.data)
      setCustomerPages((old) =>
        customerCursor
          ? merge(old, customers.data!.items)
          : customers.data!.items,
      );
  }, [customers.data, customerCursor]);
  const messages = useStaffInbox(section === "alerts");
  const [operationalPages, setOperationalPages] = useState<
      Record<string, BookingRecord[]>
    >({}),
    [operationCursors, setOperationCursors] = useState<
      Record<string, string | null>
    >({});
  async function moreOperations(kind: string) {
    await run(async () => {
      const data = await staffRequest<Page<BookingRecord>>(
        `/admin/operations?${queryString({ kind, day, cursor: operationCursors[kind] || "" })}`,
      );
      setOperationalPages((old) => ({
        ...old,
        [kind]: merge(old[kind] || [], data.items),
      }));
      setOperationCursors((old) => ({ ...old, [kind]: data.nextCursor }));
    });
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operațiunea nu a reușit.");
    } finally {
      setBusy(false);
    }
  }
  async function mutate(b: BookingRecord, action: string, reason = "") {
    const result = await command<{ booking: BookingRecord }>(
      `/admin/bookings/${b.id}/${action}`,
      { expectedRevision: b.revision, reason },
    );
    setSelection((current) =>
      current && current !== "new" && current.id === b.id
        ? result.booking
        : current,
    );
    setPages((old) =>
      old.map((item) => (item.id === b.id ? result.booking : item)),
    );
    setOperationalPages((old) =>
      Object.fromEntries(
        Object.entries(old).map(([kind, rows]) => [
          kind,
          rows.map((item) => (item.id === b.id ? result.booking : item)),
        ]),
      ),
    );
    setNotice("Operațiunea a fost salvată.");
    invalidateAdmin(["/admin/bookings", "/admin/customers", "/admin/reports"]);
  }
  async function open(id: string) {
    await run(async () => {
      const result = await staffRequest<{ booking: BookingRecord }>(
        `/admin/bookings/${id}`,
      );
      setSelection(result.booking);
    });
  }
  const activeError =
    error ||
    live.error ||
    (section === "bookings"
      ? bookings.error
      : section === "reports"
        ? report.error
        : section === "loyalty"
          ? customers.error
          : section === "alerts"
            ? messages.error
            : "");
  function navigate(key: string) {
    setSection(key);
    setMenu(false);
    setNotice("");
    setError("");
  }
  return (
    <div className="shell">
      {menu && (
        <button
          className="scrim"
          aria-label="Închide meniul"
          onClick={() => setMenu(false)}
        />
      )}
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <div className="brand">
          <span className="brand-icon">
            <CarFront size={24} />
          </span>
          <strong>Parcare Aeroport Iași</strong>
          <button
            className="icon-button mobile-only"
            aria-label="Închide meniul"
            onClick={() => setMenu(false)}
          >
            <X />
          </button>
        </div>
        <nav aria-label="Panou de administrare">
          {sections
            .filter(([key]) => key !== "settings" || session.role === "admin")
            .map(([key, title]) => (
              <button
                key={key}
                aria-current={section === key ? "page" : undefined}
                onClick={() => navigate(key)}
              >
                {title}
                {key === "alerts" && notifications.unread > 0 && (
                  <span className="nav-count">{notifications.unread}</span>
                )}
              </button>
            ))}
        </nav>
        <div className="account">
          <div>
            <strong>
              {session.role === "admin" ? "Administrator" : "Operator"}
            </strong>
            <small>{session.email}</small>
          </div>
          <button
            className="icon-button"
            aria-label="Deconectare"
            onClick={() =>
              void run(async () => {
                clearAdminCache();
                await onLogout();
              })
            }
          >
            <LogOut size={19} />
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar connected-topbar">
          <button
            className="icon-button mobile-only"
            aria-label="Deschide meniul"
            onClick={() => setMenu(true)}
          >
            <Menu />
          </button>
          <span>{day} · Europe/Bucharest</span>
          <span className="demo-label">
            Acces activ ·{" "}
            {session.role === "admin" ? "Administrator" : "Operator"}
          </span>
          <button
            className="button secondary verify-access"
            aria-label="Verifică accesul"
            onClick={() => void onVerify()}
          >
            Verifică accesul
          </button>
          <button
            className="icon-button"
            aria-label={`Notificări, ${notifications.unread} necitite`}
            onClick={() => navigate("alerts")}
          >
            <Bell />
            {notifications.unread || ""}
          </button>
        </header>
        <main className="content">
          <div className="page-title">
            <div>
              <h1>{sections.find(([key]) => key === section)?.[1]}</h1>
              <p>
                {section === "today"
                  ? "Sosiri, plecări și restanțe. Confirmările sunt înregistrate de personal."
                  : "Date salvate în evidența parcării."}
              </p>
            </div>
            {["today", "bookings"].includes(section) && (
              <button
                className="button primary"
                onClick={() => setSelection("new")}
              >
                <Plus size={18} />
                Rezervare nouă
              </button>
            )}
          </div>
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
          {activeError && (
            <p className="error" role="alert">
              {activeError}
            </p>
          )}
          {(section === "today" || section === "alerts") && (
            <>
              {section === "today" && (
                <div className="metrics">
                  {[
                    ["Sosiri azi", live.stats.arrivals],
                    ["Plecări azi", live.stats.departures],
                    ["Mașini în parcare", live.stats.parked],
                  ].map(([title, count]) => (
                    <div className="panel metric" key={title}>
                      <div>
                        <span>{title}</span>
                        <strong>{count}</strong>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {!live.ready && <p>Se încarcă programul…</p>}
              <div className="columns">
                {(["arrival", "departure", "parked"] as const).map((kind) => {
                  const rows = merge(
                    operationalPages[kind] || [],
                    live.rows[kind] || [],
                  ).sort((a, b) =>
                    (kind === "arrival"
                      ? a.arrival
                      : a.departure
                    ).localeCompare(
                      kind === "arrival" ? b.arrival : b.departure,
                    ),
                  );
                  const valid = rows.filter(
                    (b) =>
                      b.bookingStatus === "confirmed" &&
                      b.movementStatus ===
                        (kind === "arrival" ? "waiting" : "parked"),
                  );
                  const filtered =
                    section === "alerts"
                      ? valid.filter(
                          (b) =>
                            (kind === "arrival" ? b.arrival : b.departure) <
                              now ||
                            (kind === "departure" &&
                              Date.parse(b.departureAt) - Date.now() <
                                30 * 60_000),
                        )
                      : valid;
                  return (
                    <section className="panel" key={kind}>
                      <h2>
                        {kind === "arrival"
                          ? "Sosiri"
                          : kind === "departure"
                            ? "Plecări"
                            : "În parcare"}
                      </h2>
                      {!filtered.length && (
                        <p className="empty">Nicio rezervare de afișat.</p>
                      )}
                      <ul className="time-list">
                        {filtered.map((b) => (
                          <li className="movement-row" key={b.id}>
                            <button
                              className="time-row"
                              onClick={() => setSelection(b)}
                            >
                              <span>
                                {when(
                                  kind === "arrival" ? b.arrival : b.departure,
                                )}
                              </span>
                              <span className="row-client">
                                <strong>{b.name}</strong>
                                <span>{b.licensePlate}</span>
                                {(kind === "arrival"
                                  ? b.arrival
                                  : b.departure) < now && (
                                  <small className="late-label">
                                    De verificat · ora programată a trecut
                                  </small>
                                )}
                              </span>
                            </button>
                            <button
                              className="button secondary"
                              disabled={busy}
                              onClick={() =>
                                void run(() =>
                                  mutate(
                                    b,
                                    kind === "arrival" ? "arrive" : "depart",
                                  ),
                                )
                              }
                            >
                              {kind === "arrival"
                                ? "Confirmă sosirea"
                                : "Confirmă plecarea"}
                            </button>
                          </li>
                        ))}
                      </ul>
                      {(live.rows[kind].length >= 50 ||
                        operationCursors[kind]) && (
                        <button
                          className="button secondary"
                          disabled={busy || operationCursors[kind] === null}
                          onClick={() => void moreOperations(kind)}
                        >
                          Încarcă mai multe
                        </button>
                      )}
                    </section>
                  );
                })}
              </div>
            </>
          )}
          {section === "bookings" && (
            <section className="panel">
              <div className="filters">
                <label>
                  Caută
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Nume, telefon, auto sau cod"
                  />
                </label>
                <label>
                  Stare
                  <select
                    value={filters.status}
                    onChange={(e) =>
                      setFilters({ ...filters, status: e.target.value })
                    }
                  >
                    <option value="">Toate</option>
                    {Object.entries({ ...bookingLabels, ...movementLabels })
                      .filter(([k]) => k !== "confirmed")
                      .map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Plată
                  <select
                    value={filters.payment}
                    onChange={(e) =>
                      setFilters({ ...filters, payment: e.target.value })
                    }
                  >
                    <option value="">Toate</option>
                    {Object.entries(paymentLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Sursă
                  <select
                    value={filters.source}
                    onChange={(e) =>
                      setFilters({ ...filters, source: e.target.value })
                    }
                  >
                    <option value="">Toate</option>
                    <option value="app">Aplicație</option>
                    <option value="manual">Manuală</option>
                    <option value="website">Site</option>
                  </select>
                </label>
                {(["from", "to"] as const).map((key) => (
                  <label key={key}>
                    {key === "from" ? "De la" : "Până la"}
                    <input
                      type="date"
                      value={filters[key]}
                      onChange={(e) =>
                        setFilters({ ...filters, [key]: e.target.value })
                      }
                    />
                  </label>
                ))}
                <button
                  className="button secondary"
                  onClick={() => void bookings.refresh()}
                >
                  <RefreshCw size={16} />
                  Actualizează
                </button>
              </div>
              <p className="cache-note">
                Căutare după început de cuvânt: minimum 2 caractere sau 4 cifre
                la telefon. Intervalul include sosirea sau plecarea.
              </p>
              <BookingTable
                rows={pages}
                loading={bookings.loading}
                onOpen={setSelection}
              />
              {bookings.data?.nextCursor && (
                <button
                  className="button secondary"
                  onClick={() => setCursor(bookings.data!.nextCursor!)}
                >
                  Încarcă mai multe
                </button>
              )}
            </section>
          )}
          {section === "reports" && (
            <section className="panel">
              <div className="filters">
                <button
                  className="button secondary"
                  onClick={() => setRange({ ...range, from: day, to: day })}
                >
                  Azi
                </button>
                <button
                  className="button secondary"
                  onClick={() =>
                    setRange({
                      ...range,
                      from: shiftDay(day, 1),
                      to: shiftDay(day, 1),
                    })
                  }
                >
                  Mâine
                </button>
                {(["from", "to"] as const).map((key) => (
                  <label key={key}>
                    {key === "from" ? "De la" : "Până la"}
                    <input
                      type="date"
                      value={range[key]}
                      onChange={(e) =>
                        setRange({ ...range, [key]: e.target.value })
                      }
                    />
                  </label>
                ))}
                <label>
                  Tip
                  <select
                    value={range.kind}
                    onChange={(e) =>
                      setRange({ ...range, kind: e.target.value })
                    }
                  >
                    <option value="">Toate</option>
                    <option value="arrival">Sosiri</option>
                    <option value="departure">Plecări</option>
                  </select>
                </label>
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const blob = await exportCsv(
                          `/admin/reports/export?${reportKey}`,
                        ),
                        url = URL.createObjectURL(blob),
                        a = document.createElement("a");
                      a.href = url;
                      a.download = "raport-parcare.csv";
                      a.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                      setNotice(
                        "Export complet generat. Datele pot fi modificate de operatori în timpul generării.",
                      );
                    })
                  }
                >
                  Export CSV complet
                </button>
                <button
                  className="button secondary"
                  onClick={() => void report.refresh()}
                >
                  Actualizează
                </button>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Tip</th>
                      <th>Programat</th>
                      <th>Efectiv</th>
                      <th>Client / auto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportPages.map((m) => (
                      <tr key={m.id}>
                        <td>{m.kind === "arrival" ? "Sosire" : "Plecare"}</td>
                        <td>{when(m.scheduledLocal)}</td>
                        <td>
                          {m.actualAt ? localTime(new Date(m.actualAt)) : "—"}
                        </td>
                        <td>
                          <button
                            className="text-button"
                            onClick={() => void open(m.bookingId)}
                          >
                            {m.name} · {m.licensePlate}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!reportPages.length && (
                <p className="empty">
                  {report.loading
                    ? "Se încarcă…"
                    : "Nicio mișcare în interval."}
                </p>
              )}
              {report.data?.nextCursor && (
                <button
                  className="button secondary"
                  onClick={() => setReportCursor(report.data!.nextCursor!)}
                >
                  Încarcă mai multe
                </button>
              )}
            </section>
          )}
          {section === "loyalty" && (
            <section className="panel">
              <h2>Clienți recurenți</h2>
              <div className="filters">
                <label>
                  Caută client
                  <input
                    value={customerSearch}
                    onChange={(e) => setCustomerSearch(e.target.value)}
                    placeholder="Început de nume sau telefon"
                  />
                </label>
                <button
                  className="button secondary"
                  onClick={() => void customers.refresh()}
                >
                  Actualizează
                </button>
              </div>
              <p className="cache-note">
                Minimum două rezervări confirmate, neanulate. Punctele se acordă
                la încasare.
              </p>
              {customerPages.map((c) => (
                <button
                  className="customer-row"
                  key={c.id}
                  onClick={() => setCustomer(c)}
                >
                  <span>
                    <strong>{c.name}</strong>
                    <small>
                      {c.phone} · {c.reservationCount} rezervări
                    </small>
                  </span>
                  <span>
                    {c.points} puncte
                    <small>
                      {c.benefitStatus === "available"
                        ? `Reducere ${c.benefitPercent}%`
                        : c.benefitStatus === "reserved"
                          ? "Beneficiu rezervat"
                          : "Fără beneficiu disponibil"}
                    </small>
                  </span>
                </button>
              ))}
              {!customerPages.length && (
                <p className="empty">
                  {customers.loading
                    ? "Se încarcă…"
                    : "Nu există clienți recurenți."}
                </p>
              )}
              {customers.data?.nextCursor && (
                <button
                  className="button secondary"
                  onClick={() => setCustomerCursor(customers.data!.nextCursor!)}
                >
                  Încarcă mai multe
                </button>
              )}
            </section>
          )}
          {section === "alerts" && (
            <section className="panel">
              <div className="panel-heading">
                <h2>Notificări</h2>
                <button
                  className="button secondary"
                  onClick={() =>
                    void run(async () => {
                      await staffRequest("/notifications/read-all", "POST");
                      invalidateAdmin(["/notifications"]);
                    })
                  }
                >
                  Marchează toate citite
                </button>
              </div>
              {messages.items.map((n) => (
                <div className="customer-row" key={n.id}>
                  <button
                    className="text-button"
                    onClick={() =>
                      void run(async () => {
                        await staffRequest(
                          `/notifications/${n.id}/read`,
                          "POST",
                        );
                        const result = await staffRequest<{
                          booking: BookingRecord;
                        }>(`/admin/bookings/${n.bookingId}`);
                        setSelection(result.booking);
                        invalidateAdmin(["/notifications"]);
                      })
                    }
                  >
                    {n.title} · {n.message}
                  </button>
                </div>
              ))}
              {!messages.items.length && (
                <p className="empty">Nicio notificare.</p>
              )}
              {messages.hasMore && (
                <button
                  className="button secondary"
                  onClick={() => void messages.more()}
                >
                  Încarcă mai multe notificări
                </button>
              )}
            </section>
          )}
          {section === "settings" && session.role === "admin" && (
            <Settings
              onSaved={() => {
                setNotice("Setările au fost salvate.");
                invalidateAdmin(["/config"]);
              }}
            />
          )}
        </main>
      </div>
      {selection && (
        <BookingEditor
          key={selection === "new" ? "new" : selection.id}
          booking={selection === "new" ? undefined : selection}
          onClose={() => setSelection(null)}
          onSaved={(booking) => {
            setSelection(booking);
            setPages((old) =>
              old.map((b) => (b.id === booking.id ? booking : b)),
            );
            invalidateAdmin([
              "/admin/bookings",
              "/admin/customers",
              "/admin/reports",
            ]);
          }}
        />
      )}
      {customer && (
        <CustomerEditor
          key={customer.id}
          customer={customer}
          onClose={() => setCustomer(null)}
          onSaved={(c) => {
            setCustomer(c);
            setCustomerPages((old) =>
              old.map((item) => (item.id === c.id ? c : item)),
            );
            invalidateAdmin(["/admin/customers"]);
          }}
          onOpen={(id) => {
            setCustomer(null);
            void open(id);
          }}
        />
      )}
    </div>
  );
}
function merge<T extends { id: string }>(old: T[], next: T[]) {
  const map = new Map(old.map((item) => [item.id, item]));
  next.forEach((item) => map.set(item.id, item));
  return [...map.values()];
}
function BookingTable({
  rows,
  loading,
  onOpen,
}: {
  rows: BookingRecord[];
  loading: boolean;
  onOpen: (b: BookingRecord) => void;
}) {
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Cod / Client</th>
              <th>Auto / Telefon</th>
              <th>Sosire / Plecare</th>
              <th>Stare</th>
              <th>Plată</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id}>
                <td>
                  <button className="text-button" onClick={() => onOpen(b)}>
                    <strong>{b.name}</strong>
                    <small>{b.code}</small>
                  </button>
                </td>
                <td>
                  {b.licensePlate}
                  <small>{b.phone}</small>
                </td>
                <td>
                  {when(b.arrival)}
                  <small>{when(b.departure)}</small>
                </td>
                <td>
                  <span className="pill" data-state={label(b)}>
                    {label(b)}
                  </span>
                </td>
                <td>{paymentLabels[b.paymentStatus]}</td>
                <td>{currency.format(b.pricing.totalBani / 100)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <p className="empty">{loading ? "Se încarcă…" : "Nicio rezervare."}</p>
      )}
    </>
  );
}
function BookingEditor({
  booking,
  onClose,
  onSaved,
}: {
  booking?: BookingRecord;
  onClose: () => void;
  onSaved: (b: BookingRecord) => void;
}) {
  const dialog = useModal(),
    command = useCommand();
  const [current, setCurrent] = useState(booking),
    [editing, setEditing] = useState(!booking),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [reason, setReason] = useState(""),
    [auditCursor, setAuditCursor] = useState(""),
    [auditRows, setAuditRows] = useState<AuditRecord[]>([]);
  const [manualTotal, setManualTotal] = useState("");
  const [values, setValues] = useState<BookingInput>(() =>
    booking
      ? {
          name: booking.name,
          phone: booking.phone,
          licensePlate: booking.licensePlate,
          flight: booking.flight,
          arrival: booking.arrival,
          departure: booking.departure,
        }
      : {
          name: "",
          phone: "",
          licensePlate: "",
          flight: "",
          arrival: localTime(),
          departure: "",
        },
  );
  const audit = useAdminResource<Page<AuditRecord>>(
    current
      ? `/admin/bookings/${current.id}/audit?cursor=${encodeURIComponent(auditCursor)}`
      : null,
  );
  useEffect(() => {
    if (booking) setCurrent(booking);
  }, [booking]);
  useEffect(() => {
    if (audit.data)
      setAuditRows((old) =>
        auditCursor ? merge(old, audit.data!.items) : audit.data!.items,
      );
  }, [audit.data, auditCursor]);
  async function save(action = "edit") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await command<{ booking: BookingRecord }>(
        current
          ? action === "edit"
            ? `/admin/bookings/${current.id}`
            : `/admin/bookings/${current.id}/${action}`
          : "/admin/bookings",
        current
          ? {
              expectedRevision: current.revision,
              reason,
              ...(action === "edit"
                ? {
                    details: values,
                    ...(manualTotal !== ""
                      ? {
                          manualTotalBani: Math.round(
                            Number(manualTotal) * 100,
                          ),
                        }
                      : {}),
                  }
                : {}),
            }
          : {
              ...values,
              ...(manualTotal !== ""
                ? {
                    manualTotalBani: Math.round(Number(manualTotal) * 100),
                    reason,
                  }
                : {}),
            },
        current && action === "edit" ? "PATCH" : "POST",
      );
      setCurrent(result.booking);
      setEditing(false);
      onSaved(result.booking);
      invalidateAdmin(["/audit"]);
      void audit.refresh();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Salvarea nu a reușit. Datele sunt păstrate.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="booking-dialog"
      aria-labelledby="booking-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-head">
        <div>
          <h2 id="booking-title">
            {current ? current.name : "Rezervare nouă"}
          </h2>
          {current && (
            <p>
              {current.code} · {label(current)}
            </p>
          )}
        </div>
        <button
          className="icon-button"
          aria-label="Închide"
          disabled={busy}
          onClick={onClose}
        >
          <X />
        </button>
      </div>
      <div className="dialog-body detail-sections">
        {error && (
          <div role="alert">
            <p className="error">{error}</p>
            {current && (
              <button
                className="button secondary"
                onClick={() =>
                  void staffRequest<{ booking: BookingRecord }>(
                    `/admin/bookings/${current.id}`,
                  )
                    .then((result) => {
                      setCurrent(result.booking);
                      setError(
                        "Versiunea actuală a fost încărcată. Formularul tău este păstrat; verifică diferențele înainte de salvare.",
                      );
                    })
                    .catch((e) => setError(e.message))
                }
              >
                Reîncarcă versiunea actuală
              </button>
            )}
          </div>
        )}
        {editing ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="form-grid">
              {(
                [
                  ["name", "Nume client", "text"],
                  ["phone", "Telefon", "tel"],
                  ["licensePlate", "Număr auto", "text"],
                  ["flight", "Zbor (opțional)", "text"],
                  ["arrival", "Sosire programată", "datetime-local"],
                  ["departure", "Plecare programată", "datetime-local"],
                ] as const
              ).map(([key, label, type]) => (
                <label key={key}>
                  {label}
                  <input
                    type={type}
                    required={key !== "flight"}
                    value={values[key]}
                    disabled={busy}
                    onChange={(e) =>
                      setValues({ ...values, [key]: e.target.value })
                    }
                  />
                </label>
              ))}
            </div>
            <p className="cache-note">
              Orele sunt ale parcării (Europe/Bucharest). Totalul este calculat
              pe server din tarifele configurate.
            </p>
            {(!current || current.paymentStatus === "unpaid") && (
              <label>
                Total personalizat (lei, opțional)
                <input
                  type="number"
                  min="0"
                  max="1000000"
                  step="0.01"
                  value={manualTotal}
                  onChange={(e) => setManualTotal(e.target.value)}
                  placeholder="Gol = tariful calculat"
                />
              </label>
            )}
            {(current || manualTotal !== "") && (
              <label>
                Motivul modificării
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={500}
                />
              </label>
            )}
            <div className="actions">
              <button className="button primary" disabled={busy}>
                {busy ? "Se salvează…" : "Salvează"}
              </button>
              {current && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setEditing(false)}
                >
                  Înapoi la detalii
                </button>
              )}
            </div>
          </form>
        ) : (
          current && (
            <>
              <dl className="form-grid details">
                <div>
                  <dt>Client</dt>
                  <dd>
                    {current.name} · {current.phone}
                  </dd>
                </div>
                <div>
                  <dt>Auto / zbor</dt>
                  <dd>
                    {current.licensePlate} · {current.flight || "—"}
                  </dd>
                </div>
                <div>
                  <dt>Sosire programată</dt>
                  <dd>{when(current.arrival)}</dd>
                </div>
                <div>
                  <dt>Plecare programată</dt>
                  <dd>{when(current.departure)}</dd>
                </div>
                <div>
                  <dt>Sosire efectivă</dt>
                  <dd>
                    {current.arrivedAt
                      ? when(localTime(new Date(current.arrivedAt)))
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Plecare efectivă</dt>
                  <dd>
                    {current.departedAt
                      ? when(localTime(new Date(current.departedAt)))
                      : "—"}
                  </dd>
                </div>
              </dl>
              <p>
                <strong>
                  {currency.format(current.pricing.totalBani / 100)}
                </strong>{" "}
                · {paymentLabels[current.paymentStatus]}
              </p>
              {current.pricing.discountBani > 0 && (
                <p>
                  Reducere:{" "}
                  {currency.format(current.pricing.discountBani / 100)}
                </p>
              )}
              {current.priceDifferenceBani !== 0 && (
                <p className="notice">
                  Diferență de regularizat:{" "}
                  {currency.format(current.priceDifferenceBani / 100)}.
                  Încasarea rămâne{" "}
                  {currency.format(current.paidAmountBani / 100)}.
                </p>
              )}
              {current.bookingStatus !== "cancelled" && (
                <>
                  <label>
                    Motiv (obligatoriu pentru anulare)
                    <input
                      value={reason}
                      maxLength={500}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                  <div className="actions">
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => setEditing(true)}
                    >
                      Editează
                    </button>
                    {current.bookingStatus === "requested" && (
                      <button
                        className="button primary"
                        disabled={busy}
                        onClick={() => void save("confirm")}
                      >
                        Confirmă cererea
                      </button>
                    )}
                    {current.bookingStatus === "confirmed" &&
                      current.movementStatus === "waiting" && (
                        <button
                          className="button primary"
                          disabled={busy}
                          onClick={() => void save("arrive")}
                        >
                          Confirmă sosirea
                        </button>
                      )}
                    {current.movementStatus === "parked" && (
                      <button
                        className="button primary"
                        disabled={busy}
                        onClick={() => void save("depart")}
                      >
                        Confirmă plecarea
                      </button>
                    )}
                    {current.bookingStatus === "confirmed" &&
                      current.paymentStatus === "unpaid" && (
                        <button
                          className="button secondary"
                          disabled={busy}
                          onClick={() => void save("payment-at-site")}
                        >
                          Marchează achitat la locație
                        </button>
                      )}
                    {current.movementStatus !== "parked" && (
                      <button
                        className="button danger"
                        disabled={busy || reason.trim().length < 3}
                        onClick={() => void save("cancel")}
                      >
                        Anulează rezervarea
                      </button>
                    )}
                  </div>
                  <p className="cache-note">
                    Încasarea se înregistrează după primirea banilor. Anularea
                    păstrează istoricul plății și nu produce rambursare.
                  </p>
                </>
              )}
              <section>
                <h3>Activitate</h3>
                {auditRows.map((a) => (
                  <p key={a.id}>
                    {a.action} ·{" "}
                    {new Date(a.createdAt).toLocaleString("ro-RO", {
                      timeZone: "Europe/Bucharest",
                    })}
                    {a.reason ? ` · ${a.reason}` : ""}
                  </p>
                ))}
                {audit.data?.nextCursor && (
                  <button
                    className="button secondary"
                    onClick={() => setAuditCursor(audit.data!.nextCursor!)}
                  >
                    Mai multă activitate
                  </button>
                )}
              </section>
            </>
          )
        )}
      </div>
    </dialog>
  );
}
function Settings({ onSaved }: { onSaved: () => void }) {
  const resource = useAdminResource<{ config: BookingConfig }>(
      "/config",
      900_000,
    ),
    command = useCommand();
  const [values, setValues] = useState<BookingConfig | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (resource.data && !values) setValues(resource.data.config);
  }, [resource.data, values]);
  if (!values) return <p>{resource.error || "Se încarcă setările…"}</p>;
  return (
    <section className="panel">
      <h2>Tarife și fidelizare</h2>
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          const { revision, configured, timeZone, currency, ...body } = values;
          void command<{ config: BookingConfig }>(
            "/admin/config",
            { ...body, expectedRevision: revision },
            "PUT",
          )
            .then((result) => {
              setValues(result.config);
              onSaved();
            })
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          Tarif pe zi începută (lei)
          <input
            type="number"
            min="0.01"
            max="1000000"
            step="0.01"
            required
            value={values.dailyRateBani / 100 || ""}
            onChange={(e) =>
              setValues({
                ...values,
                dailyRateBani: Math.round(Number(e.target.value) * 100),
              })
            }
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={values.requestsEnabled}
            onChange={(e) =>
              setValues({ ...values, requestsEnabled: e.target.checked })
            }
          />
          Permite cereri din aplicație, confirmate de personal
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={values.loyaltyEnabled}
            onChange={(e) =>
              setValues({ ...values, loyaltyEnabled: e.target.checked })
            }
          />
          Activează programul de fidelizare
        </label>
        <div className="form-grid">
          {(
            [
              ["pointsPerDay", "Puncte per zi achitată", 0, 10000],
              [
                "benefitThreshold",
                "Prag de puncte pentru beneficiu",
                1,
                1000000,
              ],
              ["benefitPercent", "Reducere (%)", 1, 100],
              [
                "arrivalReminderMinutes",
                "Memento sosire (minute înainte; 0 = oprit)",
                0,
                10080,
              ],
              [
                "departureReminderMinutes",
                "Memento plecare (minute înainte; 0 = oprit)",
                0,
                1440,
              ],
            ] as const
          ).map(([key, title, min, max]) => (
            <label key={key}>
              {title}
              <input
                type="number"
                required
                min={min}
                max={max}
                step="1"
                value={values[key]}
                onChange={(e) =>
                  setValues({ ...values, [key]: Number(e.target.value) })
                }
              />
            </label>
          ))}
        </div>
        <p className="cache-note">
          O zi înseamnă 24 de ore începute. Punctele se acordă numai la
          încasare. La prima atingere a pragului se acordă un beneficiu; alte
          beneficii pot fi acordate manual. Reducerea este rezervată cererii și
          consumată la încasare. Tarifele noi nu modifică prețurile rezervărilor
          plătite. Mementourile sunt verificate la intervale de 15 minute;
          setările se aplică rezervărilor noi sau actualizate.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
            <button
              type="button"
              className="button secondary"
              onClick={() =>
                void resource.refresh().then(() => setValues(null))
              }
            >
              Reîncarcă setările
            </button>
          </p>
        )}
        <button className="button primary" disabled={busy}>
          {busy ? "Se salvează…" : "Salvează setările"}
        </button>
      </form>
    </section>
  );
}
function CustomerEditor({
  customer,
  onClose,
  onSaved,
  onOpen,
}: {
  customer: LoyaltyRecord;
  onClose: () => void;
  onSaved: (c: LoyaltyRecord) => void;
  onOpen: (id: string) => void;
}) {
  const dialog = useModal(),
    command = useCommand(),
    [cursor, setCursor] = useState(""),
    [historyRows, setHistoryRows] = useState<BookingRecord[]>([]),
    [ledgerCursor, setLedgerCursor] = useState(""),
    [ledgerRows, setLedgerRows] = useState<
      (AuditRecord & { delta?: number; pointsDelta?: number })[]
    >([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const history = useAdminResource<Page<BookingRecord>>(
      `/admin/customers/${customer.id}/bookings?cursor=${encodeURIComponent(cursor)}`,
    ),
    ledger = useAdminResource<
      Page<AuditRecord & { delta?: number; pointsDelta?: number }>
    >(
      `/admin/customers/${customer.id}/ledger?cursor=${encodeURIComponent(ledgerCursor)}`,
    );
  useEffect(() => {
    if (history.data)
      setHistoryRows((old) =>
        cursor ? merge(old, history.data!.items) : history.data!.items,
      );
  }, [history.data, cursor]);
  useEffect(() => {
    if (ledger.data)
      setLedgerRows((old) =>
        ledgerCursor ? merge(old, ledger.data!.items) : ledger.data!.items,
      );
  }, [ledger.data, ledgerCursor]);
  return (
    <dialog
      ref={dialog}
      className="booking-dialog"
      aria-labelledby="customer-title"
      onCancel={onClose}
    >
      <div className="dialog-head">
        <div>
          <h2 id="customer-title">{customer.name}</h2>
          <p>
            {customer.phone} · {customer.points} puncte
          </p>
        </div>
        <button className="icon-button" aria-label="Închide" onClick={onClose}>
          <X />
        </button>
      </div>
      <div className="dialog-body detail-sections">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            const data = new FormData(event.currentTarget);
            setBusy(true);
            setError("");
            void command<{ loyalty: LoyaltyRecord }>(
              `/admin/customers/${customer.id}/loyalty-adjustments`,
              {
                expectedRevision: customer.revision,
                pointsDelta: Number(data.get("points")),
                benefitAction: data.get("benefit"),
                reason: data.get("reason"),
              },
            )
              .then((result) => {
                onSaved(result.loyalty);
                invalidateAdmin(["/ledger"]);
                void ledger.refresh();
              })
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <div className="form-grid">
            <label>
              Ajustare puncte (+ sau −)
              <input
                name="points"
                type="number"
                step="1"
                defaultValue="0"
                required
              />
            </label>
            <label>
              Beneficiu
              <select name="benefit">
                <option value="keep">Păstrează</option>
                <option value="grant">Acordă reducerea configurată</option>
                <option value="consume">Marchează utilizat</option>
              </select>
            </label>
          </div>
          <label>
            Motivul ajustării
            <input name="reason" required minLength={3} maxLength={500} />
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
              <button
                type="button"
                className="button secondary"
                onClick={() =>
                  void staffRequest<{ loyalty: LoyaltyRecord }>(
                    `/admin/customers/${customer.id}`,
                  )
                    .then((result) => {
                      onSaved(result.loyalty);
                      setError(
                        "Versiunea actuală a fost încărcată. Verifică ajustarea înainte de salvare.",
                      );
                    })
                    .catch((e) => setError(e.message))
                }
              >
                Reîncarcă versiunea actuală
              </button>
            </p>
          )}
          <button className="button primary" disabled={busy}>
            Salvează ajustarea
          </button>
        </form>
        <section>
          <h3>Istoric rezervări</h3>
          {historyRows.map((b) => (
            <p key={b.id}>
              <button className="text-button" onClick={() => onOpen(b.id)}>
                {b.code} · {b.licensePlate} · {label(b)}
              </button>
            </p>
          ))}
          {history.data?.nextCursor && (
            <button
              className="button secondary"
              onClick={() => setCursor(history.data!.nextCursor!)}
            >
              Încarcă mai multe
            </button>
          )}
        </section>
        <section>
          <h3>Istoric puncte</h3>
          {ledgerRows.map((l) => (
            <p key={l.id}>
              {l.action} · {l.delta ?? l.pointsDelta ?? 0} puncte · {l.reason}
            </p>
          ))}
          {ledger.data?.nextCursor && (
            <button
              className="button secondary"
              onClick={() => setLedgerCursor(ledger.data!.nextCursor!)}
            >
              Încarcă mai multe ajustări
            </button>
          )}
        </section>
      </div>
    </dialog>
  );
}
