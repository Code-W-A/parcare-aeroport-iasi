import { randomUUID } from "node:crypto";
import {
  FieldValue,
  Timestamp,
  getFirestore,
  type Transaction,
} from "firebase-admin/firestore";
import { ApiError } from "../access";
import type {
  BookingConfig,
  BookingInput,
  BookingRecord,
  GuestProfile,
  LoyaltyRecord,
  NotificationMeta,
  Quote,
} from "../contracts";
import {
  assertRevision,
  bookingDto,
  defaultConfig,
  emptyCustomer,
  hash,
  period,
  prefixes,
  pricing,
} from "./domain";
const db = () => getFirestore();
export const configRef = () => db().doc("publicConfig/booking");
export async function getConfig(): Promise<BookingConfig> {
  const s = await configRef().get();
  return s.exists ? (s.data() as BookingConfig) : defaultConfig;
}
export function commandRef(
  actor: string,
  scope: string,
  key: string | undefined,
) {
  if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key))
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Cheia operațiunii lipsește sau este invalidă.",
    );
  return db().doc(`idempotency/${hash([actor, scope, key])}`);
}
export async function quoteFor(
  uid: string,
  input: { arrival: string; departure: string; applyBenefit: boolean },
): Promise<Quote> {
  const [config, customerSnap] = await Promise.all([
    getConfig(),
    db().doc(`customers/guest_${uid}`).get(),
  ]);
  const customer = customerSnap.data() as LoyaltyRecord | undefined;
  const available =
    config.loyaltyEnabled && customer?.benefitStatus === "available";
  if (input.applyBenefit && !available)
    throw new ApiError(409, "CONFLICT", "Beneficiul nu mai este disponibil.");
  return {
    ...pricing(
      input,
      config,
      input.applyBenefit ? customer!.benefitPercent : 0,
    ),
    arrival: input.arrival,
    departure: input.departure,
    benefitRevision: customer?.revision || 0,
    benefitId: input.applyBenefit ? customer!.benefitId : null,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
}
export async function saveConfig(
  actor: string,
  input: Omit<
    BookingConfig,
    "configured" | "revision" | "currency" | "timeZone"
  > & { expectedRevision: number },
  key: string | undefined,
) {
  const ref = commandRef(actor, "config", key),
    fingerprint = hash(input);
  return db().runTransaction(async (tx) => {
    const [seen, snapshot] = await tx.getAll(ref, configRef());
    if (seen.exists) {
      if (seen.get("fingerprint") !== fingerprint)
        throw new ApiError(
          409,
          "CONFLICT",
          "Cheia a fost folosită pentru alte date.",
        );
      return seen.get("result") as BookingConfig;
    }
    const actual = snapshot.exists
      ? (snapshot.data() as BookingConfig)
      : defaultConfig;
    assertRevision(actual.revision, input.expectedRevision);
    const { expectedRevision, ...fields } = input;
    const result: BookingConfig = {
      ...fields,
      configured: true,
      revision: actual.revision + 1,
      currency: "RON",
      timeZone: "Europe/Bucharest",
    };
    tx.set(configRef(), result);
    tx.create(ref, { fingerprint, result, createdAt: Timestamp.now() });
    tx.create(db().collection("configurationAudit").doc(), {
      actorUid: actor,
      createdAt: Timestamp.now(),
      revision: result.revision,
      action: "settings",
    });
    return result;
  });
}
// Read notification metadata before any writes; deterministic IDs make retries harmless.
async function prepareNotices(
  tx: Transaction,
  ownerUid: string | null,
  includeStaff: boolean,
  event: string,
  bookingId: string,
  title: string,
  message: string,
) {
  const recipients = new Set<string>();
  if (ownerUid) recipients.add(ownerUid);
  if (includeStaff) {
    const staff = await tx.get(
      db().collection("staffAccess").where("enabled", "==", true).limit(51),
    );
    if (staff.size > 50)
      throw new ApiError(
        503,
        "UNAVAILABLE",
        "Lista destinatarilor trebuie configurată pentru o echipă mai mare.",
      );
    staff.docs.forEach((s) => recipients.add(s.id));
  }
  const refs = [...recipients].map((uid) =>
    db().doc(`users/${uid}/meta/notifications`),
  );
  const metadata = refs.length ? await tx.getAll(...refs) : [];
  return () =>
    metadata.forEach((s, index) => {
      const meta = (s.data() || {
        sequence: 0,
        unread: 0,
        readThrough: 0,
      }) as NotificationMeta;
      const sequence = meta.sequence + 1,
        ref = refs[index];
      tx.set(ref, { ...meta, sequence, unread: meta.unread + 1 });
      tx.create(ref.parent.parent!.collection("notifications").doc(event), {
        bookingId,
        title,
        message,
        sequence,
        createdAt: Timestamp.now(),
        readAt: null,
      });
    });
}
function projection(
  tx: Transaction,
  id: string,
  old: FirebaseFirestore.DocumentData | null,
  next: FirebaseFirestore.DocumentData,
) {
  const eligible = (b: FirebaseFirestore.DocumentData | null) =>
    b?.bookingStatus === "confirmed";
  const delta = new Map<string, { arrivals: number; departures: number }>();
  for (const [b, sign] of [
    [old, -1],
    [next, 1],
  ] as const)
    if (b && eligible(b)) {
      const a = delta.get(b.arrivalDay) || { arrivals: 0, departures: 0 };
      a.arrivals += sign;
      delta.set(b.arrivalDay, a);
      const d = delta.get(b.departureDay) || { arrivals: 0, departures: 0 };
      d.departures += sign;
      delta.set(b.departureDay, d);
    }
  for (const [day, d] of delta)
    if (d.arrivals || d.departures)
      tx.set(
        db().doc(`dailyStats/${day}`),
        {
          arrivals: FieldValue.increment(d.arrivals),
          departures: FieldValue.increment(d.departures),
        },
        { merge: true },
      );
  const parked = (b: FirebaseFirestore.DocumentData | null) =>
    eligible(b) && b?.movementStatus === "parked" ? 1 : 0;
  if (parked(next) !== parked(old))
    tx.set(
      db().doc("liveStats/parking"),
      { parked: FieldValue.increment(parked(next) - parked(old)) },
      { merge: true },
    );
  for (const kind of ["arrival", "departure"] as const) {
    const local = next[kind],
      at = next[`${kind}At`];
    tx.set(db().doc(`movements/${id}_${kind}`), {
      bookingId: id,
      code: next.code,
      kind,
      active: eligible(next),
      scheduledAt: at,
      scheduledLocal: local,
      actualAt: kind === "arrival" ? next.arrivedAt : next.departedAt,
      name: next.name,
      phone: next.phone,
      licensePlate: next.licensePlate,
      paymentStatus: next.paymentStatus,
      amountBani: next.pricing.totalBani,
      revision: next.revision,
    });
  }
}
function customerWrite(tx: Transaction, customer: LoyaltyRecord) {
  tx.set(db().doc(`customers/${customer.id}`), {
    ...customer,
    searchPrefixes: prefixes(customer.name, customer.phone, customer.email),
  });
  if (customer.ownerUid)
    tx.set(db().doc(`users/${customer.ownerUid}/meta/loyalty`), customer);
}
function scheduleReminders(
  tx: Transaction,
  id: string,
  b: FirebaseFirestore.DocumentData,
  config: BookingConfig,
) {
  for (const kind of ["arrival", "departure"] as const) {
    const offset =
      kind === "arrival"
        ? config.arrivalReminderMinutes
        : config.departureReminderMinutes;
    const active =
      b.ownerUid &&
      b.bookingStatus === "confirmed" &&
      offset > 0 &&
      b.movementStatus !== "departed" &&
      (kind !== "arrival" || b.movementStatus === "waiting");
    tx.set(db().doc(`jobs/${id}_${kind}`), {
      bookingId: id,
      kind,
      revision: b.revision,
      status: active ? "pending" : "cancelled",
      dueAt: Timestamp.fromMillis(b[`${kind}At`].toMillis() - offset * 60_000),
    });
  }
}
export type CreateInput = BookingInput & {
  applyBenefit?: boolean;
  configRevision?: number;
  benefitRevision?: number;
  expiresAt?: string;
  customerId?: string;
  manualTotalBani?: number;
  reason?: string;
};
export async function createBooking(
  actor: string,
  guest: boolean,
  input: CreateInput,
  key: string | undefined,
): Promise<{
  booking: BookingRecord;
  loyalty: LoyaltyRecord;
  profile?: GuestProfile;
}> {
  const idem = commandRef(actor, "create-booking", key),
    fingerprint = hash(input),
    ref = db().collection("bookings").doc();
  return db().runTransaction(async (tx) => {
    const seen = await tx.get(idem);
    if (seen.exists) {
      if (seen.get("fingerprint") !== fingerprint)
        throw new ApiError(
          409,
          "CONFLICT",
          "Cheia a fost folosită pentru altă rezervare.",
        );
      return seen.get("result");
    }
    const profile = guest ? await tx.get(db().doc(`users/${actor}`)) : null;
    if (guest && !profile?.exists)
      throw new ApiError(409, "CONFLICT", "Completează întâi profilul guest.");
    const customerId = guest
      ? `guest_${actor}`
      : input.customerId || `manual_${hash(input.phone.replace(/\D/g, ""))}`;
    const [configSnap, customerSnap] = await tx.getAll(
      configRef(),
      db().doc(`customers/${customerId}`),
    );
    const config = (configSnap.data() || defaultConfig) as BookingConfig;
    if (guest && !config.requestsEnabled)
      throw new ApiError(
        409,
        "CONFLICT",
        "Cererile de rezervare nu sunt activate momentan.",
      );
    if (!guest && input.customerId && !customerSnap.exists)
      throw new ApiError(
        404,
        "NOT_FOUND",
        "Clientul selectat nu mai este disponibil.",
      );
    const customer = (customerSnap.data() ||
      emptyCustomer(
        customerId,
        input,
        guest ? actor : null,
        profile?.get("email") || "",
      )) as LoyaltyRecord;
    if (guest) {
      if (
        input.configRevision !== config.revision ||
        input.benefitRevision !== customer.revision
      )
        throw new ApiError(
          409,
          "CONFLICT",
          "Tariful sau beneficiul s-a modificat. Actualizează sumarul.",
        );
      if (!input.expiresAt || Date.parse(input.expiresAt) < Date.now())
        throw new ApiError(
          409,
          "CONFLICT",
          "Oferta a expirat. Actualizează sumarul.",
        );
      if (period(input).arrivalAt.toMillis() < Date.now())
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Sosirea trebuie programată în viitor.",
        );
    }
    const useBenefit = !!input.applyBenefit;
    if (
      useBenefit &&
      (!config.loyaltyEnabled || customer.benefitStatus !== "available")
    )
      throw new ApiError(409, "CONFLICT", "Beneficiul nu mai este disponibil.");
    const cost = pricing(
        input,
        config,
        useBenefit ? customer.benefitPercent : 0,
      ),
      times = period(input),
      now = Timestamp.now();
    const booking = {
      name: input.name,
      phone: input.phone,
      licensePlate: input.licensePlate,
      flight: input.flight,
      arrival: input.arrival,
      departure: input.departure,
      ...times,
      days: undefined,
      code: `IAS-${ref.id.slice(0, 10).toUpperCase()}`,
      ownerUid: customer.ownerUid,
      customerId,
      source: guest ? "app" : "manual",
      bookingStatus: guest ? "requested" : "confirmed",
      paymentStatus: "unpaid",
      movementStatus: "waiting",
      arrivedAt: null,
      departedAt: null,
      createdAt: now,
      updatedAt: now,
      pricing: cost,
      revision: 1,
      paidAmountBani: 0,
      priceDifferenceBani: 0,
      loyaltyAwarded: false,
      loyaltyPoints: 0,
      pointsPerDay: config.pointsPerDay,
      loyaltyEnabled: config.loyaltyEnabled,
      benefitId: useBenefit ? customer.benefitId : null,
      searchPrefixes: prefixes(
        input.name,
        input.phone,
        input.licensePlate,
        `IAS-${ref.id.slice(0, 10).toUpperCase()}`,
      ),
    };
    if (input.manualTotalBani !== undefined) {
      if (guest || !input.reason || input.reason.trim().length < 3)
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Completează motivul sumei personalizate.",
        );
      booking.pricing.manualAdjustmentBani =
        input.manualTotalBani - booking.pricing.totalBani;
      booking.pricing.totalBani = input.manualTotalBani;
    }
    delete booking.days;
    const notify = await prepareNotices(
      tx,
      customer.ownerUid,
      true,
      hash([ref.id, "created"]),
      ref.id,
      guest ? "Cerere de rezervare trimisă" : "Rezervare confirmată",
      `${booking.code} · ${input.licensePlate}`,
    );
    const nextCustomer = {
      ...customer,
      name: input.name,
      phone: input.phone,
      revision: customer.revision + 1,
      reservationCount: customer.reservationCount + (guest ? 0 : 1),
      ...(useBenefit
        ? { benefitStatus: "reserved" as const, reservedBookingId: ref.id }
        : {}),
    };
    tx.create(ref, booking);
    customerWrite(tx, nextCustomer);
    projection(tx, ref.id, null, booking);
    scheduleReminders(tx, ref.id, booking, config);
    notify();
    tx.create(ref.collection("audit").doc("created"), {
      actorUid: actor,
      action: guest ? "request" : "create",
      reason: input.reason || "",
      createdAt: now,
    });
    const updatedProfile: GuestProfile | undefined = profile
      ? {
          uid: actor,
          kind: "guest",
          email: profile.get("email"),
          name: input.name,
          phone: input.phone,
          licensePlate: input.licensePlate,
          revision: profile.get("revision") + 1,
          updatedAt: now.toDate().toISOString(),
        }
      : undefined;
    if (updatedProfile)
      tx.update(profile!.ref, {
        name: input.name,
        phone: input.phone,
        licensePlate: input.licensePlate,
        revision: updatedProfile.revision,
        updatedAt: now,
      });
    const result = {
      booking: bookingDto(ref.id, booking),
      loyalty: nextCustomer,
      ...(updatedProfile ? { profile: updatedProfile } : {}),
    };
    tx.create(idem, { fingerprint, result, createdAt: now });
    return result;
  });
}
export type Action =
  | "edit"
  | "confirm"
  | "arrive"
  | "depart"
  | "payment-at-site"
  | "cancel";
export async function mutateBooking(
  actor: string,
  id: string,
  action: Action,
  input: {
    expectedRevision: number;
    reason?: string;
    details?: BookingInput;
    manualTotalBani?: number;
  },
  key: string | undefined,
) {
  const idem = commandRef(actor, `booking:${id}:${action}`, key),
    fingerprint = hash(input),
    ref = db().doc(`bookings/${id}`);
  return db().runTransaction(async (tx) => {
    const [seen, snap] = await tx.getAll(idem, ref);
    if (seen.exists) {
      if (seen.get("fingerprint") !== fingerprint)
        throw new ApiError(
          409,
          "CONFLICT",
          "Cheia a fost folosită pentru alte date.",
        );
      return seen.get("result") as {
        booking: BookingRecord;
        loyalty: LoyaltyRecord;
      };
    }
    if (!snap.exists)
      throw new ApiError(404, "NOT_FOUND", "Rezervarea nu există.");
    const old = snap.data()!;
    assertRevision(old.revision, input.expectedRevision);
    if (old.bookingStatus === "cancelled")
      throw new ApiError(409, "CONFLICT", "Rezervarea este anulată.");
    const [customerSnap, configSnap] = await tx.getAll(
      db().doc(`customers/${old.customerId}`),
      configRef(),
    );
    const config = (configSnap.data() || defaultConfig) as BookingConfig;
    const customer = customerSnap.data() as LoyaltyRecord;
    if (!customer)
      throw new ApiError(
        409,
        "CONFLICT",
        "Evidența clientului nu este disponibilă.",
      );
    const next: FirebaseFirestore.DocumentData = {
      ...old,
      revision: old.revision + 1,
      updatedAt: Timestamp.now(),
    };
    let nextCustomer = { ...customer, revision: customer.revision + 1 };
    if (action === "edit") {
      if (!input.details)
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Datele rezervării lipsesc.",
        );
      const changed =
        old.arrival !== input.details.arrival ||
        old.departure !== input.details.departure;
      if (old.movementStatus === "departed" && changed)
        throw new ApiError(
          409,
          "CONFLICT",
          "Perioada unei rezervări încheiate nu mai poate fi modificată.",
        );
      if (
        old.movementStatus === "parked" &&
        old.arrival !== input.details.arrival
      )
        throw new ApiError(
          409,
          "CONFLICT",
          "Sosirea programată nu se modifică după intrare.",
        );
      Object.assign(next, input.details, period(input.details));
      delete next.days;
      if (changed) {
        const proposed = pricing(
          input.details,
          config,
          old.pricing.discountPercent || 0,
        );
        if (old.paymentStatus !== "unpaid") {
          if (!input.reason?.trim())
            throw new ApiError(
              400,
              "VALIDATION_ERROR",
              "Explică modificarea perioadei plătite; încasarea rămâne neschimbată.",
            );
          next.priceDifferenceBani = proposed.totalBani - old.paidAmountBani;
        } else next.pricing = proposed;
      }
      if (input.manualTotalBani !== undefined) {
        if (old.paymentStatus !== "unpaid")
          throw new ApiError(
            409,
            "CONFLICT",
            "Suma încasată nu poate fi modificată.",
          );
        if (!input.reason || input.reason.trim().length < 3)
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            "Completează motivul sumei personalizate.",
          );
        const base =
          next.pricing.totalBani - (next.pricing.manualAdjustmentBani || 0);
        next.pricing = {
          ...next.pricing,
          manualAdjustmentBani: input.manualTotalBani - base,
          totalBani: input.manualTotalBani,
        };
      }
      next.searchPrefixes = prefixes(
        next.name,
        next.phone,
        next.licensePlate,
        next.code,
      );
      nextCustomer = { ...nextCustomer, name: next.name, phone: next.phone };
    } else if (action === "confirm") {
      if (old.bookingStatus !== "requested")
        throw new ApiError(409, "CONFLICT", "Cererea este deja soluționată.");
      next.bookingStatus = "confirmed";
      nextCustomer.reservationCount++;
    } else if (action === "arrive") {
      if (old.bookingStatus !== "confirmed" || old.movementStatus !== "waiting")
        throw new ApiError(
          409,
          "CONFLICT",
          "Sosirea nu poate fi confirmată în starea actuală.",
        );
      next.movementStatus = "parked";
      next.arrivedAt = Timestamp.now();
    } else if (action === "depart") {
      if (old.movementStatus !== "parked")
        throw new ApiError(409, "CONFLICT", "Confirmă întâi sosirea.");
      next.movementStatus = "departed";
      next.departedAt = Timestamp.now();
    } else if (action === "payment-at-site") {
      if (old.bookingStatus !== "confirmed" || old.paymentStatus !== "unpaid")
        throw new ApiError(
          409,
          "CONFLICT",
          "Încasarea este deja înregistrată sau rezervarea nu este confirmată.",
        );
      next.paymentStatus = "paid_at_site";
      next.paidAmountBani = old.pricing.totalBani;
      const earned = old.loyaltyEnabled
        ? old.pricing.days * old.pointsPerDay
        : 0;
      next.loyaltyAwarded = true;
      next.loyaltyPoints = earned;
      nextCustomer.points += earned;
      if (old.benefitId) {
        if (
          customer.reservedBookingId !== id ||
          customer.benefitId !== old.benefitId
        )
          throw new ApiError(
            409,
            "CONFLICT",
            "Rezervarea beneficiului nu mai este validă.",
          );
        nextCustomer.benefitStatus = "consumed";
        nextCustomer.reservedBookingId = null;
      }
      if (
        config.loyaltyEnabled &&
        !["available", "reserved"].includes(nextCustomer.benefitStatus) &&
        customer.points < config.benefitThreshold &&
        nextCustomer.points >= config.benefitThreshold
      ) {
        nextCustomer.benefitId = randomUUID();
        nextCustomer.benefitPercent = config.benefitPercent;
        nextCustomer.benefitStatus = "available";
      }
    } else if (action === "cancel") {
      if (old.movementStatus === "parked")
        throw new ApiError(
          409,
          "CONFLICT",
          "Înregistrează plecarea înainte de anulare.",
        );
      if (!input.reason?.trim())
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Completează motivul anulării.",
        );
      next.bookingStatus = "cancelled";
      if (old.bookingStatus === "confirmed") nextCustomer.reservationCount--;
      if (old.paymentStatus === "unpaid" && customer.reservedBookingId === id) {
        nextCustomer.benefitStatus = "available";
        nextCustomer.reservedBookingId = null;
      }
    }
    const titles: Record<Action, string> = {
      edit: "Rezervare actualizată",
      confirm: "Rezervare confirmată",
      arrive: "Sosire înregistrată",
      depart: "Plecare înregistrată",
      "payment-at-site": "Încasare la locație înregistrată",
      cancel: "Rezervare anulată",
    };
    const notify = await prepareNotices(
      tx,
      old.ownerUid,
      false,
      hash([id, next.revision]),
      id,
      titles[action],
      `${next.code} · ${next.licensePlate}`,
    );
    tx.set(ref, next);
    customerWrite(tx, nextCustomer);
    projection(tx, id, old, next);
    scheduleReminders(tx, id, next, config);
    notify();
    if (action === "payment-at-site")
      tx.create(
        db().doc(`customers/${old.customerId}/loyaltyLedger/payment_${id}`),
        {
          actorUid: actor,
          action: "earn",
          delta: next.loyaltyPoints,
          bookingId: id,
          reason: "Încasare la locație",
          createdAt: Timestamp.now(),
        },
      );
    tx.create(ref.collection("audit").doc(String(next.revision)), {
      actorUid: actor,
      action,
      reason: input.reason || "",
      createdAt: Timestamp.now(),
    });
    const result = { booking: bookingDto(id, next), loyalty: nextCustomer };
    tx.create(idem, { fingerprint, result, createdAt: Timestamp.now() });
    return result;
  });
}
export async function adjustLoyalty(
  actor: string,
  id: string,
  input: {
    expectedRevision: number;
    pointsDelta: number;
    benefitAction: "keep" | "grant" | "consume";
    reason: string;
  },
  key: string | undefined,
) {
  const idem = commandRef(actor, `loyalty:${id}`, key),
    fingerprint = hash(input),
    ref = db().doc(`customers/${id}`);
  return db().runTransaction(async (tx) => {
    const [seen, snap, configSnap] = await tx.getAll(idem, ref, configRef());
    if (seen.exists) {
      if (seen.get("fingerprint") !== fingerprint)
        throw new ApiError(
          409,
          "CONFLICT",
          "Cheia a fost folosită pentru alte date.",
        );
      return seen.get("result") as LoyaltyRecord;
    }
    if (!snap.exists)
      throw new ApiError(404, "NOT_FOUND", "Clientul nu există.");
    const old = snap.data() as LoyaltyRecord;
    assertRevision(old.revision, input.expectedRevision);
    const config = (configSnap.data() || defaultConfig) as BookingConfig;
    if (old.points + input.pointsDelta < 0)
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Soldul punctelor nu poate fi negativ.",
      );
    if (input.benefitAction !== "keep" && old.benefitStatus === "reserved")
      throw new ApiError(
        409,
        "CONFLICT",
        "Beneficiul este rezervat unei cereri active.",
      );
    const result = {
      ...old,
      points: old.points + input.pointsDelta,
      revision: old.revision + 1,
    };
    if (input.benefitAction === "grant") {
      if (!config.loyaltyEnabled)
        throw new ApiError(409, "CONFLICT", "Activează programul în Setări.");
      result.benefitId = randomUUID();
      result.benefitPercent = config.benefitPercent;
      result.benefitStatus = "available";
    }
    if (input.benefitAction === "consume") result.benefitStatus = "consumed";
    const notify = await prepareNotices(
      tx,
      old.ownerUid,
      false,
      idem.id,
      "",
      "Beneficii actualizate",
      `Sold curent: ${result.points} puncte`,
    );
    customerWrite(tx, result);
    notify();
    tx.create(ref.collection("loyaltyLedger").doc(idem.id), {
      actorUid: actor,
      action: "adjust",
      ...input,
      createdAt: Timestamp.now(),
    });
    tx.create(idem, { fingerprint, result, createdAt: Timestamp.now() });
    return result;
  });
}
export async function readNotification(uid: string, id?: string) {
  const metaRef = db().doc(`users/${uid}/meta/notifications`);
  return db().runTransaction(async (tx) => {
    const metaSnap = await tx.get(metaRef);
    const meta = (metaSnap.data() || {
      sequence: 0,
      unread: 0,
      readThrough: 0,
    }) as NotificationMeta;
    if (!id) {
      const next = { ...meta, unread: 0, readThrough: meta.sequence };
      tx.set(metaRef, next);
      return next;
    }
    const ref = db().doc(`users/${uid}/notifications/${id}`),
      s = await tx.get(ref);
    if (!s.exists)
      throw new ApiError(404, "NOT_FOUND", "Notificarea nu există.");
    if (s.get("readAt") || s.get("sequence") <= meta.readThrough) return meta;
    const next = { ...meta, unread: Math.max(0, meta.unread - 1) };
    tx.update(ref, { readAt: Timestamp.now() });
    tx.set(metaRef, next);
    return next;
  });
}
export async function processNotificationJobs(max = 100) {
  const due = await db()
    .collection("jobs")
    .where("status", "==", "pending")
    .where("dueAt", "<=", Timestamp.now())
    .orderBy("dueAt")
    .limit(max)
    .get();
  let delivered = 0;
  for (const job of due.docs)
    await db().runTransaction(async (tx) => {
      const fresh = await tx.get(job.ref);
      if (fresh.get("status") !== "pending" || fresh.get("dueAt").toMillis() > Date.now()) return;
      const snap = await tx.get(db().doc(`bookings/${fresh.get("bookingId")}`)),
        b = snap.data(),
        kind = fresh.get("kind");
      if (
        !b ||
        b.revision !== fresh.get("revision") ||
        b.bookingStatus !== "confirmed" ||
        !b.ownerUid ||
        b.movementStatus === "departed" ||
        (kind === "arrival" && b.movementStatus !== "waiting") ||
        b[`${kind}At`].toMillis() < Date.now()
      ) {
        tx.update(job.ref, { status: "cancelled" });
        return;
      }
      const event = hash([job.id, b[`${kind}At`].toMillis()]),
        sentRef = db().doc(`reminderEvents/${event}`),
        sent = await tx.get(sentRef);
      if (sent.exists) {
        tx.update(job.ref, { status: "done" });
        return;
      }
      const notify = await prepareNotices(
        tx,
        b.ownerUid,
        false,
        event,
        snap.id,
        kind === "arrival" ? "Se apropie sosirea" : "Se apropie plecarea",
        `${b.code} · ${kind === "arrival" ? b.arrival : b.departure}`,
      );
      notify();
      tx.create(sentRef, { createdAt: Timestamp.now() });
      tx.update(job.ref, { status: "done" });
      delivered++;
    });
  return { examined: due.size, delivered };
}
