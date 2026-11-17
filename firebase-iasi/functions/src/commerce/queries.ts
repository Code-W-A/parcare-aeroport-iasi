import {
  FieldPath,
  Filter,
  Timestamp,
  getFirestore,
  type Query,
} from "firebase-admin/firestore";
import { ApiError } from "../access";
import {
  bookingDto,
  hash,
  iso,
  localInstant,
  localTime,
  normalize,
} from "./domain";
import type { Page, ReportMovement } from "../contracts";
export type Params = Record<string, unknown>;
const text = (p: Params, key: string) =>
  typeof p[key] === "string" ? (p[key] as string) : "";
const invalidCursor = () =>
  new ApiError(400, "VALIDATION_ERROR", "Cursor invalid.");
function cursorTimestamp(value: unknown): Timestamp {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw invalidCursor();
  // Firestore timestamps only cover years 0001–9999. Convert inside the guard
  // so malformed client input never becomes a retryable server error.
  try {
    return Timestamp.fromMillis(value);
  } catch {
    throw invalidCursor();
  }
}
function cursorScalar(value: unknown): string | number {
  if (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  throw invalidCursor();
}
export const id = (raw: unknown) => {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw))
    throw new ApiError(400, "VALIDATION_ERROR", "Identificator invalid.");
  return raw;
};
export function dayRange(p: Params) {
  const from = text(p, "from"),
    to = text(p, "to");
  for (const day of [from, to])
    if (day) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
        throw new ApiError(400, "VALIDATION_ERROR", "Interval invalid.");
      localInstant(day + "T12:00");
    }
  if (from && to && from > to)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Data de început trebuie să fie înaintea datei finale.",
    );
  return { from, to };
}
export async function page<T>(
  query: Query,
  p: Params,
  scope: unknown,
  sort: string,
  direction: "asc" | "desc",
  timestamp: boolean,
  map: (id: string, d: FirebaseFirestore.DocumentData) => T,
  max = 50,
  extraFields: string[] = [],
): Promise<Page<T>> {
  const sizeRaw = text(p, "limit"),
    size = sizeRaw ? Number(sizeRaw) : max;
  if (!Number.isInteger(size) || size < 1 || size > max)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Dimensiunea paginii este invalidă.",
    );
  const fingerprint = hash([scope, extraFields]);
  let ordered = query.orderBy(sort, direction);
  for (const field of extraFields) ordered = ordered.orderBy(field, "asc");
  ordered = ordered.orderBy(FieldPath.documentId(), direction);
  if (p.cursor !== undefined && typeof p.cursor !== "string")
    throw invalidCursor();
  if (text(p, "cursor")) {
    let cursor;
    try {
      if (text(p, "cursor").length > 2000) throw Error();
      cursor = JSON.parse(
        Buffer.from(text(p, "cursor"), "base64url").toString("utf8"),
      );
    } catch {
      throw new ApiError(400, "VALIDATION_ERROR", "Cursor invalid.");
    }
    if (
      !cursor ||
      typeof cursor !== "object" ||
      Array.isArray(cursor) ||
      cursor.q !== fingerprint ||
      typeof cursor.id !== "string" ||
      !Array.isArray(cursor.extra) ||
      cursor.extra.length !== extraFields.length
    )
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Cursorul nu corespunde filtrelor.",
      );
    const extra = cursor.extra.map((value: unknown, index: number) => {
      return extraFields[index].endsWith("At")
        ? cursorTimestamp(value)
        : cursorScalar(value);
    });
    ordered = ordered.startAfter(
      timestamp ? cursorTimestamp(cursor.value) : cursorScalar(cursor.value),
      ...extra,
      id(cursor.id),
    );
  }
  const snapshot = await ordered.limit(size + 1).get(),
    docs = snapshot.docs.slice(0, size),
    last = docs.at(-1);
  return {
    items: docs.map((s) => map(s.id, s.data())),
    nextCursor:
      snapshot.size > size && last
        ? Buffer.from(
            JSON.stringify({
              q: fingerprint,
              id: last.id,
              extra: extraFields.map((field) => {
                const value = last.get(field);
                return value instanceof Timestamp ? value.toMillis() : value;
              }),
              value: timestamp ? last.get(sort).toMillis() : last.get(sort),
            }),
          ).toString("base64url")
        : null,
  };
}
export function adminQuery(p: Params) {
  const conditions: Filter[] = [];
  const status = text(p, "status"),
    payment = text(p, "payment"),
    source = text(p, "source"),
    raw = text(p, "search");
  const { from, to } = dayRange(p);
  if (status) {
    if (status === "cancellation_pending")
      conditions.push(
        Filter.where("cancellationRequest.status", "==", "pending"),
      );
    else if (["requested", "confirmed", "cancelled"].includes(status))
      conditions.push(Filter.where("bookingStatus", "==", status));
    else if (["waiting", "parked", "departed"].includes(status))
      conditions.push(
        Filter.where("bookingStatus", "==", "confirmed"),
        Filter.where("movementStatus", "==", status),
      );
    else throw new ApiError(400, "VALIDATION_ERROR", "Stare invalidă.");
  }
  if (payment) {
    if (!["unpaid", "paid_at_site", "paid_online"].includes(payment))
      throw new ApiError(400, "VALIDATION_ERROR", "Stare de plată invalidă.");
    conditions.push(Filter.where("paymentStatus", "==", payment));
  }
  if (source) {
    if (!["app", "manual", "website"].includes(source))
      throw new ApiError(400, "VALIDATION_ERROR", "Sursă invalidă.");
    conditions.push(Filter.where("source", "==", source));
  }
  const search = normalize(raw);
  if (search) {
    if (search.length < (/^[\d +()-]+$/.test(raw) ? 4 : 2))
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Caută minimum 2 caractere sau 4 cifre pentru telefon.",
      );
    conditions.push(
      Filter.where("searchPrefixes", "array-contains", search.slice(0, 24)),
    );
  }
  if (from || to) {
    const part = (field: string) =>
      Filter.and(
        ...[
          ...(from ? [Filter.where(field, ">=", from)] : []),
          ...(to ? [Filter.where(field, "<=", to)] : []),
        ],
      );
    conditions.push(Filter.or(part("arrivalDay"), part("departureDay")));
  }
  let q: Query = getFirestore().collection("bookings");
  if (conditions.length) q = q.where(Filter.and(...conditions));
  return { q, filters: { status, payment, source, search, from, to } };
}
export async function adminBookings(p: Params) {
  const { q, filters } = adminQuery(p);
  return page(
    q,
    p,
    ["admin", filters],
    "arrivalAt",
    "desc",
    true,
    bookingDto,
    50,
    filters.from || filters.to ? ["arrivalDay", "departureDay"] : [],
  );
}
export async function ownBookings(uid: string, p: Params) {
  const tab = text(p, "tab") || "upcoming";
  if (!["upcoming", "ongoing", "history"].includes(tab))
    throw new ApiError(400, "VALIDATION_ERROR", "Tab invalid.");
  const asOf = text(p, "asOf") || new Date().toISOString(),
    ms = Date.parse(asOf);
  if (!Number.isFinite(ms) || ms < -62135596800000 || ms >= 253402300800000)
    throw new ApiError(400, "VALIDATION_ERROR", "Moment invalid.");
  const now = Timestamp.fromMillis(ms);
  let q: Query = getFirestore()
      .collection("bookings")
      .where("ownerUid", "==", uid),
    sort = "arrivalAt",
    direction: "asc" | "desc" = "asc";
  if (tab === "upcoming")
    q = q
      .where("bookingStatus", "in", ["requested", "confirmed"])
      .where("movementStatus", "in", ["waiting", "parked"])
      .where("arrivalAt", ">", now);
  if (tab === "ongoing") {
    q = q
      .where("bookingStatus", "in", ["requested", "confirmed"])
      .where("arrivalAt", "<=", now)
      .where("departureAt", ">=", now)
      .where("movementStatus", "in", ["waiting", "parked"]);
    direction = "desc";
  }
  if (tab === "history") {
    q = q.where(
      Filter.or(
        Filter.where("departureAt", "<", now),
        Filter.where("bookingStatus", "==", "cancelled"),
        Filter.where("movementStatus", "==", "departed"),
      ),
    );
    sort = "departureAt";
    direction = "desc";
  }
  return {
    ...(await page(
      q,
      p,
      ["own", uid, tab, asOf],
      sort,
      direction,
      true,
      bookingDto,
      20,
      tab === "ongoing" ? ["departureAt"] : [],
    )),
    asOf,
  };
}
export async function operations(p: Params) {
  const kind = text(p, "kind") || "arrival";
  if (!["arrival", "departure", "parked"].includes(kind))
    throw new ApiError(400, "VALIDATION_ERROR", "Tip invalid.");
  const day = text(p, "day") || localTime(new Date()).slice(0, 10);
  dayRange({ from: day, to: day });
  let q: Query = getFirestore()
    .collection("bookings")
    .where("bookingStatus", "==", "confirmed");
  const sort = kind === "arrival" ? "arrivalAt" : "departureAt";
  if (kind === "parked") q = q.where("movementStatus", "==", "parked");
  else if (kind === "arrival")
    q = q
      .where("movementStatus", "==", "waiting")
      .where("arrivalDay", "<=", day);
  else
    q = q
      .where("movementStatus", "==", "parked")
      .where("departureDay", "<=", day);
  return page(
    q,
    p,
    ["operations", kind, day],
    sort,
    "asc",
    true,
    bookingDto,
    50,
    kind === "arrival"
      ? ["arrivalDay"]
      : kind === "departure"
        ? ["departureDay"]
        : [],
  );
}
export function reportQuery(p: Params) {
  const { from, to } = dayRange(p),
    kind = text(p, "kind");
  if (!from || !to)
    throw new ApiError(400, "VALIDATION_ERROR", "Alege intervalul raportului.");
  if (kind && !["arrival", "departure"].includes(kind))
    throw new ApiError(400, "VALIDATION_ERROR", "Tip invalid.");
  const end = new Date(to + "T12:00:00Z");
  end.setUTCDate(end.getUTCDate() + 1);
  const after = end.toISOString().slice(0, 10);
  let q: Query = getFirestore()
    .collection("movements")
    .where("active", "==", true)
    .where("scheduledAt", ">=", localInstant(from + "T00:00"))
    .where("scheduledAt", "<", localInstant(after + "T00:00"));
  if (kind) q = q.where("kind", "==", kind);
  return { q, filters: { from, to, kind } };
}
export function movementDto(
  id: string,
  d: FirebaseFirestore.DocumentData,
): ReportMovement {
  return {
    ...d,
    id,
    scheduledAt: iso(d.scheduledAt)!,
    actualAt: iso(d.actualAt),
  } as ReportMovement;
}
export async function reports(p: Params) {
  const { q, filters } = reportQuery(p);
  return page(
    q,
    p,
    ["report", filters],
    "scheduledAt",
    "asc",
    true,
    movementDto,
    100,
  );
}
