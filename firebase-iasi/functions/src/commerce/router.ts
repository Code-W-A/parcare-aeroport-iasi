import express from "express";
import { zeroFreeDays } from "./free-days";
import { getFirestore } from "firebase-admin/firestore";
import { z } from "zod";
import { ApiError, assertGuest, authenticate, staffSession } from "../access";
import {
  configSchema,
  emptyCustomer,
  inputSchema,
  iso,
  localTime,
  normalize,
  periodSchema,
  revisionSchema,
  bookingDto,
} from "./domain";
import {
  availability,
  adjustLoyalty,
  createBooking,
  getConfig,
  mutateBooking,
  quoteFor,
  readNotification,
  saveConfig,
} from "./service";
import {
  adminBookings,
  dayRange,
  id,
  movementDto,
  operations,
  ownBookings,
  page,
  reportQuery,
  reports,
} from "./queries";
export function commerceRouter() {
  const router = express.Router();
  const db = () => getFirestore();
  const route =
    (
      handler: (
        req: express.Request,
        res: express.Response,
      ) => Promise<unknown>,
    ): express.RequestHandler =>
    (req, res, next) => {
      handler(req, res).catch(next);
    };
  const key = (r: express.Request) => r.header("idempotency-key");
  router.get(
    "/config",
    route(async (_req, res) => res.json({ config: await getConfig() })),
  );
  router.put(
    "/admin/config",
    route(async (req, res) => {
      const staff = await staffSession(req);
      if (staff.role !== "admin")
        throw new ApiError(
          403,
          "FORBIDDEN",
          "Doar administratorul poate modifica setările.",
        );
      res.json({
        config: await saveConfig(
          staff.uid,
          configSchema.parse(req.body),
          key(req),
        ),
      });
    }),
  );
  router.post(
    "/availability",
    route(async (req, res) => {
      await assertGuest(req);
      res.json(await availability(inputSchema.parse(req.body)));
    }),
  );
  router.post(
    "/quotes",
    route(async (req, res) => {
      const user = await assertGuest(req);
      const input = periodSchema
        .extend({
          applyBenefit: z.boolean().default(false),
          paymentMethod: z.enum(["online", "at_parking"]).optional(),
        })
        .strict()
        .parse(req.body);
      res.json({ quote: await quoteFor(user.uid, input) });
    }),
  );
  router.post(
    "/bookings/requests",
    route(async (req, res) => {
      const user = await assertGuest(req);
      const input = inputSchema
        .extend({
          saveBilling: z.boolean().optional(),
          applyBenefit: z.boolean().default(false),
          configRevision: z.number().int(),
          benefitRevision: z.number().int(),
          expiresAt: z.string().datetime(),
        })
        .strict()
        .parse(req.body);
      res.json(await createBooking(user.uid, true, input, key(req)));
    }),
  );
  router.get(
    "/bookings",
    route(async (req, res) => {
      const user = await assertGuest(req);
      res.json(await ownBookings(user.uid, req.query));
    }),
  );
  router.post(
    "/bookings/:id/cancellation-request",
    route(async (req, res) => {
      const user = await assertGuest(req);
      const bookingId = id(req.params.id);
      const input = z
        .object({
          expectedRevision: revisionSchema,
          reason: z.string().trim().min(3).max(500),
        })
        .strict()
        .parse(req.body);
      await db().runTransaction(async (tx) => {
        const ref = db().doc(`bookings/${bookingId}`),
          snap = await tx.get(ref);
        if (!snap.exists || snap.get("ownerUid") !== user.uid)
          throw new ApiError(404, "NOT_FOUND", "Rezervare indisponibilă.");
        if (snap.get("cancellationRequest.status") === "pending") return;
        if (
          snap.get("revision") !== input.expectedRevision ||
          snap.get("bookingStatus") === "cancelled" ||
          snap.get("movementStatus") !== "waiting"
        )
          throw new ApiError(
            409,
            "CONFLICT",
            "Anularea nu mai poate fi solicitată. Actualizează rezervarea.",
          );
        tx.update(ref, {
          cancellationRequest: { status: "pending", reason: input.reason },
          revision: snap.get("revision") + 1,
        });
        tx.create(ref.collection("audit").doc(), {
          actorUid: user.uid,
          action: "cancellation-request",
          reason: input.reason,
          createdAt: new Date(),
        });
      });
      res.json({ ok: true });
    }),
  );
  router.get(
    "/bookings/:id",
    route(async (req, res) => {
      const user = await assertGuest(req);
      const snap = await db()
        .doc(`bookings/${id(req.params.id)}`)
        .get();
      if (!snap.exists || snap.get("ownerUid") !== user.uid)
        throw new ApiError(404, "NOT_FOUND", "Rezervarea nu este disponibilă.");
      res.json({ booking: bookingDto(snap.id, snap.data()!) });
    }),
  );
  router.get(
    "/loyalty",
    route(async (req, res) => {
      const user = await assertGuest(req);
      const snap = await db().doc(`users/${user.uid}/meta/loyalty`).get();
      res.json({
        loyalty: {
          ...(snap.data() || {
            ...emptyCustomer(
              `guest_${user.uid}`,
              {
                name: "",
                phone: "",
                licensePlate: "",
                flight: "",
                arrival: "",
                departure: "",
              },
              user.uid,
            ),
            revision: 0,
          }),
          ...((await getConfig()).loyaltyVersion === 2
            ? { freeDays: snap.get("freeDays") || zeroFreeDays() }
            : {}),
        },
      });
    }),
  );
  router.post(
    "/admin/bookings",
    route(async (req, res) => {
      const staff = await staffSession(req);
      const input = inputSchema
        .extend({
          manualTotalBani: z.number().int().min(0).max(100_000_000).optional(),
          reason: z.string().trim().max(500).optional(),
          customerId: z
            .string()
            .regex(/^[A-Za-z0-9_-]{1,128}$/)
            .optional(),
        })
        .strict()
        .parse(req.body);
      res.json(await createBooking(staff.uid, false, input, key(req)));
    }),
  );
  router.get(
    "/admin/bookings/search",
    route(async (req, res) => {
      await staffSession(req);
      res.json(await adminBookings(req.query));
    }),
  );
  router.get(
    "/admin/operations",
    route(async (req, res) => {
      await staffSession(req);
      res.json(await operations(req.query));
    }),
  );
  router.get(
    "/admin/stats",
    route(async (req, res) => {
      await staffSession(req);
      const day = String(req.query.day || localTime(new Date()).slice(0, 10));
      dayRange({ from: day, to: day });
      const [daily, live] = await db().getAll(
        db().doc(`dailyStats/${day}`),
        db().doc("liveStats/parking"),
      );
      res.json({
        day,
        arrivals: daily.get("arrivals") || 0,
        departures: daily.get("departures") || 0,
        parked: live.get("parked") || 0,
      });
    }),
  );
  router.get(
    "/admin/bookings/:id",
    route(async (req, res) => {
      await staffSession(req);
      const snap = await db()
        .doc(`bookings/${id(req.params.id)}`)
        .get();
      if (!snap.exists)
        throw new ApiError(404, "NOT_FOUND", "Rezervarea nu există.");
      res.json({ booking: bookingDto(snap.id, snap.data()!) });
    }),
  );
  router.get(
    "/admin/bookings/:id/audit",
    route(async (req, res) => {
      await staffSession(req);
      const bookingId = id(req.params.id);
      res.json(
        await page(
          db().collection(`bookings/${bookingId}/audit`),
          req.query,
          ["audit", bookingId],
          "createdAt",
          "desc",
          true,
          (id, data) => ({ ...data, id, createdAt: iso(data.createdAt) }),
          20,
        ),
      );
    }),
  );
  const actionSchema = z
    .object({
      expectedRevision: revisionSchema,
      reason: z.string().trim().max(500).optional(),
    })
    .strict();
  router.patch(
    "/admin/bookings/:id",
    route(async (req, res) => {
      const staff = await staffSession(req);
      const input = actionSchema
        .extend({
          details: inputSchema.strict(),
          manualTotalBani: z.number().int().min(0).max(100_000_000).optional(),
        })
        .strict()
        .parse(req.body);
      res.json(
        await mutateBooking(
          staff.uid,
          id(req.params.id),
          "edit",
          input,
          key(req),
        ),
      );
    }),
  );
  for (const action of [
    "reject-cancellation",
    "confirm",
    "arrive",
    "depart",
    "payment-at-site",
    "cancel",
  ] as const)
    router.post(
      `/admin/bookings/:id/${action}`,
      route(async (req, res) => {
        const staff = await staffSession(req);
        res.json(
          await mutateBooking(
            staff.uid,
            id(req.params.id),
            action,
            actionSchema.parse(req.body),
            key(req),
          ),
        );
      }),
    );
  router.get(
    "/admin/customers",
    route(async (req, res) => {
      await staffSession(req);
      const v2 = (await getConfig()).loyaltyVersion === 2;
      const search = normalize(String(req.query.search || ""));
      let q: FirebaseFirestore.Query = db()
        .collection("customers")
        .where("reservationCount", ">=", v2 ? 0 : 2);
      if (search) {
        if (search.length < 2)
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            "Introdu minimum 2 caractere.",
          );
        q = q.where("searchPrefixes", "array-contains", search.slice(0, 24));
      }
      res.json(
        await page(
          q,
          req.query,
          ["customers", search],
          "name",
          "asc",
          false,
          (id, data) => {
            const { searchPrefixes, ...rest } = data;
            return {
              ...rest,
              id,
              ...(v2 ? { freeDays: rest.freeDays || zeroFreeDays() } : {}),
            };
          },
          50,
          ["reservationCount"],
        ),
      );
    }),
  );
  router.get(
    "/admin/customers/:id",
    route(async (req, res) => {
      await staffSession(req);
      const snap = await db()
        .doc(`customers/${id(req.params.id)}`)
        .get();
      if (!snap.exists)
        throw new ApiError(404, "NOT_FOUND", "Clientul nu există.");
      const { searchPrefixes, ...data } = snap.data()!;
      res.json({
        loyalty: {
          ...data,
          id: snap.id,
          ...((await getConfig()).loyaltyVersion === 2
            ? { freeDays: data.freeDays || zeroFreeDays() }
            : {}),
        },
      });
    }),
  );
  router.get(
    "/admin/customers/:id/bookings",
    route(async (req, res) => {
      await staffSession(req);
      const customerId = id(req.params.id);
      res.json(
        await page(
          db().collection("bookings").where("customerId", "==", customerId),
          req.query,
          ["customer-bookings", customerId],
          "arrivalAt",
          "desc",
          true,
          bookingDto,
          20,
        ),
      );
    }),
  );
  router.get(
    "/admin/customers/:id/ledger",
    route(async (req, res) => {
      await staffSession(req);
      const customerId = id(req.params.id);
      res.json(
        await page(
          db().collection(`customers/${customerId}/loyaltyLedger`),
          req.query,
          ["ledger", customerId],
          "createdAt",
          "desc",
          true,
          (id, d) => ({ ...d, id, createdAt: iso(d.createdAt) }),
          20,
        ),
      );
    }),
  );
  router.post(
    "/admin/customers/:id/loyalty-adjustments",
    route(async (req, res) => {
      const staff = await staffSession(req);
      const input = z
        .object({
          expectedRevision: revisionSchema,
          pointsDelta: z.number().int().min(-1_000_000).max(1_000_000),
          benefitAction: z.enum(["keep", "grant", "consume"]),
          reason: z.string().trim().min(3).max(500),
        })
        .strict()
        .parse(req.body);
      res.json({
        loyalty: await adjustLoyalty(
          staff.uid,
          id(req.params.id),
          input,
          key(req),
        ),
      });
    }),
  );
  router.get(
    "/admin/reports",
    route(async (req, res) => {
      await staffSession(req);
      res.json(await reports(req.query));
    }),
  );
  router.get(
    "/admin/reports/export",
    route(async (req, res) => {
      await staffSession(req);
      const { q } = reportQuery(req.query);
      let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
      // Stream every page: bounded memory and no silent first-page truncation.
      res.set({
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="raport-parcare.csv"',
        "X-Report-Generated-At": new Date().toISOString(),
      });
      const cell = (value: unknown) => {
        let s = String(value ?? "");
        if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
        return '"' + s.replace(/"/g, '""') + '"';
      };
      res.write(
        "\uFEFF" +
          [
            "Cod",
            "Tip",
            "Programat Europe/Bucharest",
            "Efectiv UTC",
            "Client",
            "Telefon",
            "Număr auto",
            "Plată",
            "Sumă lei",
          ]
            .map(cell)
            .join(";") +
          "\r\n",
      );
      const write = async (chunk: string) => {
        if (res.destroyed || res.write(chunk)) return;
        await new Promise<void>((resolve, reject) => {
          const clean = () => {
            res.off("drain", done);
            res.off("close", done);
            res.off("error", fail);
          };
          const done = () => {
            clean();
            resolve();
          };
          const fail = (error: Error) => {
            clean();
            reject(error);
          };
          res.once("drain", done);
          res.once("close", done);
          res.once("error", fail);
        });
      };
      while (!res.destroyed) {
        const ordered = q.orderBy("scheduledAt").orderBy("__name__");
        const batch = await (cursor ? ordered.startAfter(cursor) : ordered)
          .limit(500)
          .get();
        const lines = batch.docs
          .map((s) => {
            const m = movementDto(s.id, s.data());
            return (
              [
                m.code,
                m.kind === "arrival" ? "Sosire" : "Plecare",
                m.scheduledLocal,
                m.actualAt,
                m.name,
                m.phone,
                m.licensePlate,
                m.paymentStatus,
                (m.amountBani / 100).toFixed(2),
              ]
                .map(cell)
                .join(";") + "\r\n"
            );
          })
          .join("");
        if (!res.destroyed) await write(lines);
        if (batch.size < 500) break;
        cursor = batch.docs.at(-1);
      }
      res.end();
    }),
  );
  async function notificationIdentity(req: express.Request) {
    const token = await authenticate(req);
    if (
      token.firebase.sign_in_provider !== "anonymous" &&
      token.customerSession !== true
    )
      await staffSession(req);
    return token;
  }
  router.get(
    "/notifications/meta",
    route(async (req, res) => {
      const user = await notificationIdentity(req);
      const snap = await db().doc(`users/${user.uid}/meta/notifications`).get();
      res.json({
        meta: snap.data() || { sequence: 0, unread: 0, readThrough: 0 },
      });
    }),
  );
  router.get(
    "/notifications",
    route(async (req, res) => {
      const user = await notificationIdentity(req);
      res.json(
        await page(
          db().collection(`users/${user.uid}/notifications`),
          req.query,
          ["notifications", user.uid],
          "sequence",
          "desc",
          false,
          (id, d) => ({
            ...d,
            id,
            createdAt: iso(d.createdAt),
            readAt: iso(d.readAt),
          }),
          20,
        ),
      );
    }),
  );
  router.post(
    "/notifications/read-all",
    route(async (req, res) => {
      const user = await notificationIdentity(req);
      res.json({ meta: await readNotification(user.uid) });
    }),
  );
  router.post(
    "/notifications/:id/read",
    route(async (req, res) => {
      const user = await notificationIdentity(req);
      res.json({ meta: await readNotification(user.uid, id(req.params.id)) });
    }),
  );
  return router;
}
