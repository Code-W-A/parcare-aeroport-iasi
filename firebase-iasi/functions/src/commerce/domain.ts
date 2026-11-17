import { createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { ApiError } from "../access";
import type {
  BookingConfig,
  BookingInput,
  BookingRecord,
  LoyaltyRecord,
  Pricing,
} from "../contracts";
export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const defaultConfig: BookingConfig = {
  revision: 0,
  configured: false,
  timeZone: "Europe/Bucharest",
  currency: "RON",
  dailyRateBani: 0,
  requestsEnabled: false,
  loyaltyEnabled: false,
  pointsPerDay: 0,
  benefitThreshold: 100,
  benefitPercent: 10,
  arrivalReminderMinutes: 1440,
  departureReminderMinutes: 30,
};
export const configSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    dailyRateBani: z.number().int().min(1).max(100_000_000),
    requestsEnabled: z.boolean(),
    loyaltyEnabled: z.boolean(),
    pointsPerDay: z.number().int().min(0).max(10_000),
    benefitThreshold: z.number().int().min(1).max(1_000_000),
    benefitPercent: z.number().int().min(1).max(100),
    arrivalReminderMinutes: z.number().int().min(0).max(10080),
    departureReminderMinutes: z.number().int().min(0).max(1440),
  })
  .strict();
export const phoneSchema = z
  .string()
  .trim()
  .min(9)
  .max(32)
  .regex(/^\+?[\d ()-]+$/)
  .refine((v) => /^\d{9,15}$/.test(v.replace(/\D/g, "")));
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
export const periodSchema = z.object({
  arrival: localDate,
  departure: localDate,
});
export const inputSchema = periodSchema.extend({
  name: z.string().trim().min(3).max(100),
  phone: phoneSchema,
  licensePlate: z
    .string()
    .trim()
    .min(3)
    .max(15)
    .regex(/^[\p{L}\d -]+$/u)
    .refine((v) => /\d/.test(v))
    .transform((v) => v.toUpperCase()),
  flight: z.string().trim().max(100).default(""),
});
export const revisionSchema = z.number().int().positive();
export function localTime(date: Date) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Bucharest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return parts.replace(" ", "T");
}
// Reject invalid dates, skipped spring hours and ambiguous autumn hours explicitly.
export function localInstant(value: string): Timestamp {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw new ApiError(400, "VALIDATION_ERROR", "Data sau ora este invalidă.");
  const wall = Date.parse(value + "Z");
  const candidates = [2, 3]
    .map((offset) => wall - offset * 3600_000)
    .filter((ms) => Number.isFinite(ms) && localTime(new Date(ms)) === value);
  if (candidates.length !== 1)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Ora aleasă este invalidă sau ambiguă la schimbarea orei. Alege altă oră.",
    );
  return Timestamp.fromMillis(candidates[0]);
}
export function period(input: { arrival: string; departure: string }) {
  const arrivalAt = localInstant(input.arrival),
    departureAt = localInstant(input.departure);
  const duration = departureAt.toMillis() - arrivalAt.toMillis();
  if (duration <= 0 || duration > 366 * 86400_000)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Plecarea trebuie să fie după sosire; durata maximă este un an.",
    );
  return {
    arrivalAt,
    departureAt,
    arrivalDay: input.arrival.slice(0, 10),
    departureDay: input.departure.slice(0, 10),
    days: Math.max(1, Math.ceil(duration / 86400_000)),
  };
}
export function pricing(
  input: { arrival: string; departure: string },
  config: BookingConfig,
  percent = 0,
): Pricing {
  if (!config.configured || config.dailyRateBani <= 0)
    throw new ApiError(
      409,
      "CONFLICT",
      "Tarifele trebuie configurate de administrator.",
    );
  const { days } = period(input);
  const subtotalBani = days * config.dailyRateBani;
  const discountBani = Math.round((subtotalBani * percent) / 100);
  return {
    manualAdjustmentBani: 0,
    discountPercent: percent,
    days,
    dailyRateBani: config.dailyRateBani,
    subtotalBani,
    discountBani,
    totalBani: subtotalBani - discountBani,
    configRevision: config.revision,
  };
}
export function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
export function prefixes(...values: string[]) {
  const set = new Set<string>();
  for (const raw of values)
    for (const value of [raw, ...raw.split(/\s+/)]) {
      const s = normalize(value).slice(0, 100);
      for (let n = 2; n <= Math.min(24, s.length); n++) set.add(s.slice(0, n));
    }
  return [...set].slice(0, 500);
}
export function iso(value: unknown): string | null {
  return value instanceof Timestamp
    ? value.toDate().toISOString()
    : typeof value === "string"
      ? value
      : null;
}
export function bookingDto(
  id: string,
  data: FirebaseFirestore.DocumentData,
): BookingRecord {
  const { searchPrefixes, loyaltyAwarded, loyaltyPoints, benefitId, ...rest } =
    data;
  return {
    ...rest,
    id,
    arrivalAt: iso(data.arrivalAt),
    departureAt: iso(data.departureAt),
    arrivedAt: iso(data.arrivedAt),
    departedAt: iso(data.departedAt),
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
  } as BookingRecord;
}
export function emptyCustomer(
  id: string,
  input: BookingInput,
  ownerUid: string | null,
  email = "",
): LoyaltyRecord {
  return {
    id,
    ownerUid,
    name: input.name,
    phone: input.phone,
    email,
    points: 0,
    reservationCount: 0,
    revision: 0,
    benefitId: null,
    benefitPercent: 0,
    benefitStatus: "none",
    reservedBookingId: null,
  };
}
export function assertRevision(actual: number, expected: number) {
  if (actual !== expected)
    throw new ApiError(
      409,
      "CONFLICT",
      "Datele au fost modificate între timp. Reîncarcă versiunea actuală; modificările tale sunt păstrate.",
    );
}
