import express from "express";
import { getAuth } from "firebase-admin/auth";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import { z } from "zod";
import type { GuestProfile, SavedCar } from "./contracts";
import { ApiError, assertGuest, staffSession } from "./access";
import { billingOnly, emptyDetails } from "./booking-details";
import { customerDetailsSchema, inputSchema } from "./commerce/domain";
import { commerceRouter } from "./commerce/router";

const email = z.string().trim().toLowerCase().email().max(254);
const phone = z
  .string()
  .trim()
  .min(9)
  .max(32)
  .regex(/^\+?[\d ()-]+$/)
  .refine((v) => /^\d{9,15}$/.test(v.replace(/\D/g, "")));
const sessionInput = z.object({ email, phone }).strict();
const patchInput = z
  .object({
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    savedBilling: z
      .object({
        billingType: z.enum(["individual", "company"]),
        address: z.string(),
        country: z.string(),
        county: z.string(),
        city: z.string(),
        postalCode: z.string(),
        company: z.string(),
        companyVAT: z.string(),
        companyReg: z.string(),
        companyAddress: z.string(),
      })
      .strict()
      .transform((b, ctx) => {
        const result = customerDetailsSchema.safeParse({
          ...emptyDetails("Test Client", "test@example.com"),
          carModel: "Test",
          carType: "Standard",
          ...b,
        });
        if (!result.success) {
          ctx.addIssue({
            code: "custom",
            message: "Date de facturare incomplete sau invalide.",
          });
          return z.NEVER;
        }
        return billingOnly(result.data);
      })
      .nullable()
      .optional(),
    email: email.optional(),
    phone: phone.optional(),
    name: z.string().trim().max(100).optional(),
    licensePlate: z
      .string()
      .trim()
      .max(15)
      .transform((v) => v.toUpperCase())
      .optional(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

function projectId() {
  const id = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  if (!id) throw new Error("Firebase project is not configured.");
  return id;
}
function profileDto(
  uid: string,
  data: FirebaseFirestore.DocumentData,
): GuestProfile {
  return {
    uid,
    kind: "guest",
    firstName: data.firstName || "",
    lastName: data.lastName || "",
    cars: data.cars || [],
    preferredCarId: data.preferredCarId || null,
    lastUsedCarId: data.lastUsedCarId || null,
    lastPersons: data.lastPersons || 1,
    email: data.email,
    savedBilling: data.savedBilling || null,
    phone: data.phone,
    name: data.name || "",
    licensePlate: data.licensePlate || "",
    revision: data.revision,
    updatedAt:
      data.updatedAt?.toDate?.().toISOString() || new Date().toISOString(),
  };
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const requestId = randomUUID();
    const started = Date.now();
    res.locals.requestId = requestId;
    res.set("X-Request-Id", requestId);
    res.on("finish", () => {
      console.info(
        JSON.stringify({
          event: "api_request",
          requestId,
          method: req.method,
          // Route templates omit customer identifiers and query parameters.
          route: req.route?.path ?? "unmatched",
          status: res.statusCode,
          durationMs: Date.now() - started,
        }),
      );
    });
    next();
  });
  app.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    const allowed = (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .filter(Boolean);
    const origin = req.header("origin");
    if (origin && !allowed.includes(origin))
      return res.status(403).json({
        code: "FORBIDDEN",
        message: "Origine nepermisă.",
        retryable: false,
      });
    if (origin) {
      res.set("Access-Control-Allow-Origin", origin);
      res.vary("Origin");
    }
    res.set(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Idempotency-Key",
    );
    res.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: "16kb" }));
  const route =
    (
      handler: (
        req: express.Request,
        res: express.Response,
      ) => Promise<unknown>,
    ) =>
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      handler(req, res).catch(next);
    };

  app.get("/v1/meta", (_req, res) =>
    res.json({
      projectId: projectId(),
      apiVersion: 1,
      stage: "applications",
      environment:
        process.env.FUNCTIONS_EMULATOR === "true" ? "emulator" : "cloud",
      capabilities: { bookings: true, payments: false },
    }),
  );
  app.post(
    "/v1/guest/session",
    route(async (req, res) => {
      const token = await assertGuest(req);
      const input = sessionInput.parse(req.body);
      const db = getFirestore();
      const limitRef = db.doc(
        `sessionLimits/${createHash("sha256")
          .update(req.ip || token.uid)
          .digest("hex")}`,
      );
      await db.runTransaction(async (tx) => {
        const s = await tx.get(limitRef),
          now = Date.now(),
          recent = now - (s.get("since") || 0) < 600000,
          count = recent ? s.get("count") || 0 : 0;
        if (count >= 30)
          throw new ApiError(
            429,
            "UNAVAILABLE",
            "Prea multe încercări. Reîncearcă mai târziu.",
          );
        tx.set(limitRef, {
          since: recent ? s.get("since") : now,
          count: count + 1,
        });
      });
      const ownProfile = await db.doc(`users/${token.uid}`).get();
      if (ownProfile.exists) {
        res.json({ profile: profileDto(token.uid, ownProfile.data()!) });
        return;
      }
      const normalized = input.email.trim().toLowerCase();
      const matches = await db
        .collection("users")
        .where("email", "==", normalized)
        .limit(2)
        .get();
      if (matches.size > 1)
        throw new ApiError(
          409,
          "CONFLICT",
          "Există mai multe profiluri pentru acest email. Contactează echipa.",
        );
      const identity = db.doc(
        `emailIdentities/${createHash("sha256").update(normalized).digest("hex")}`,
      );
      const targetUid = await db.runTransaction(async (tx) => {
        const index = await tx.get(identity);
        if (index.exists) return index.get("uid") as string;
        const uid = matches.docs[0]?.id || token.uid;
        tx.create(identity, { uid });
        return uid;
      });
      const identityUser = await getAuth().getUser(targetUid);
      if (identityUser.customClaims?.role)
        throw new ApiError(403, "FORBIDDEN", "Identitate indisponibilă.");
      if (targetUid !== token.uid) {
        res.json({
          customToken: await getAuth().createCustomToken(targetUid, {
            customerSession: true,
          }),
        });
        return;
      }
      const ref = db.doc(`users/${token.uid}`);
      const data = await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (snapshot.exists) {
          // Session restore is not a contact change or an ownership claim by email.
          return snapshot.data()!;
        }
        const created = {
          ...input,
          uid: token.uid,
          kind: "guest",
          name: "",
          licensePlate: "",
          revision: 1,
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now(),
        };
        transaction.create(ref, created);
        return created;
      });
      res.json({ profile: profileDto(token.uid, data) });
    }),
  );
  app.get(
    "/v1/me",
    route(async (req, res) => {
      const token = await assertGuest(req);
      const snapshot = await getFirestore().doc(`users/${token.uid}`).get();
      if (!snapshot.exists)
        throw new ApiError(
          404,
          "NOT_FOUND",
          "Completează emailul și telefonul pentru a continua.",
        );
      res.json({ profile: profileDto(token.uid, snapshot.data()!) });
    }),
  );
  app.patch(
    "/v1/me",
    route(async (req, res) => {
      const token = await assertGuest(req);
      const { expectedRevision, ...patch } = patchInput.parse(req.body);
      const ref = getFirestore().doc(`users/${token.uid}`);
      const data = await getFirestore().runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists)
          throw new ApiError(404, "NOT_FOUND", "Profilul nu este disponibil.");
        if (snapshot.get("revision") !== expectedRevision)
          throw new ApiError(
            409,
            "CONFLICT",
            "Profilul a fost modificat. Reîncarcă datele și încearcă din nou.",
          );
        const firstName = patch.firstName ?? snapshot.get("firstName") ?? "";
        const lastName = patch.lastName ?? snapshot.get("lastName") ?? "";
        const contactName = `${firstName} ${lastName}`.trim();
        if (
          (patch.firstName !== undefined || patch.lastName !== undefined) &&
          (!firstName || !lastName || contactName.length > 100)
        )
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            "Completează numele și prenumele (maximum 100 de caractere împreună).",
          );
        if (patch.email && patch.email !== snapshot.get("email")) {
          const indexRef = (value: string) =>
            getFirestore().doc(
              `emailIdentities/${createHash("sha256").update(value.toLowerCase().trim()).digest("hex")}`,
            );
          const nextIndex = indexRef(patch.email),
            previousIndex = indexRef(snapshot.get("email"));
          const [existing, oldIndex, duplicates] = await Promise.all([
            transaction.get(nextIndex),
            transaction.get(previousIndex),
            transaction.get(
              getFirestore()
                .collection("users")
                .where("email", "==", patch.email)
                .limit(2),
            ),
          ]);
          if (
            (existing.exists && existing.get("uid") !== token.uid) ||
            duplicates.docs.some((d) => d.id !== token.uid)
          )
            throw new ApiError(
              409,
              "CONFLICT",
              "Emailul este asociat altui profil.",
            );
          transaction.set(nextIndex, { uid: token.uid });
          if (oldIndex.get("uid") === token.uid)
            transaction.delete(previousIndex);
        }
        const updated = {
          ...patch,
          ...(patch.firstName !== undefined || patch.lastName !== undefined
            ? { name: contactName }
            : {}),
          revision: expectedRevision + 1,
          updatedAt: Timestamp.now(),
        };
        transaction.update(ref, updated);
        return { ...snapshot.data()!, ...updated };
      });
      res.json({ profile: profileDto(token.uid, data) });
    }),
  );
  app.post(
    "/v1/me/cars",
    route(async (req, res) => {
      const token = await assertGuest(req);
      const input = z
        .object({
          action: z.enum(["save", "remove", "prefer"]),
          expectedRevision: z.number().int().nonnegative(),
          id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
          car: z
            .object({
              plate: inputSchema.shape.licensePlate,
              model: z.string().trim().min(1).max(100),
              type: z.string().trim().min(1).max(100),
            })
            .strict()
            .optional(),
        })
        .strict()
        .parse(req.body);
      const ref = getFirestore().doc(`users/${token.uid}`);
      const data = await getFirestore().runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists)
          throw new ApiError(404, "NOT_FOUND", "Profil indisponibil.");
        if (snapshot.get("revision") !== input.expectedRevision)
          throw new ApiError(
            409,
            "CONFLICT",
            "Lista s-a modificat. Reîncarcă profilul și încearcă din nou.",
          );
        let cars = (snapshot.get("cars") || []) as SavedCar[];
        let preferredCarId = snapshot.get("preferredCarId") || null,
          lastUsedCarId = snapshot.get("lastUsedCarId") || null;
        const current = cars.find((c) => c.id === input.id);
        if (input.action === "save") {
          if (!input.car)
            throw new ApiError(
              400,
              "VALIDATION_ERROR",
              "Completează datele mașinii.",
            );
          const normalized = (s: string) => s.replace(/\s/g, "").toUpperCase();
          if (
            cars.some(
              (c) =>
                c.id !== input.id &&
                normalized(c.plate) === normalized(input.car!.plate),
            )
          )
            throw new ApiError(
              409,
              "CONFLICT",
              "Mașina este deja salvată. Selecteaz-o din listă.",
            );
          if (!current && cars.length >= 50)
            throw new ApiError(
              400,
              "VALIDATION_ERROR",
              "Poți salva maximum 50 de mașini.",
            );
          const car = { ...input.car, id: input.id };
          cars = current
            ? cars.map((c) => (c.id === input.id ? car : c))
            : [...cars, car];
          if (!preferredCarId) preferredCarId = input.id;
        } else {
          if (!current)
            throw new ApiError(
              404,
              "NOT_FOUND",
              "Mașina nu mai este disponibilă.",
            );
          if (input.action === "prefer") {
            preferredCarId = input.id;
            lastUsedCarId = input.id;
          } else {
            cars = cars.filter((c) => c.id !== input.id);
            if (preferredCarId === input.id)
              preferredCarId = cars[0]?.id || null;
            if (lastUsedCarId === input.id) lastUsedCarId = null;
          }
        }
        const patch = {
          cars,
          preferredCarId,
          lastUsedCarId,
          revision: input.expectedRevision + 1,
          updatedAt: Timestamp.now(),
        };
        tx.update(ref, patch);
        return { ...snapshot.data()!, ...patch };
      });
      res.json({ profile: profileDto(token.uid, data) });
    }),
  );
  app.get(
    "/v1/staff/session",
    route(async (req, res) => {
      res.json({ session: await staffSession(req) });
    }),
  );
  app.use("/v1", commerceRouter());
  app.use((_req, res) =>
    res.status(404).json({
      code: "NOT_FOUND",
      message: "Ruta nu este disponibilă.",
      retryable: false,
    }),
  );
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      if (
        error instanceof z.ZodError ||
        error instanceof SyntaxError ||
        (error as { type?: string })?.type === "entity.too.large"
      ) {
        return res.status(400).json({
          code: "VALIDATION_ERROR",
          message: "Verifică datele completate.",
          retryable: false,
        });
      }
      if (error instanceof ApiError)
        return res.status(error.status).json({
          code: error.code,
          message: error.message,
          retryable: error.status >= 500,
        });
      console.error("api_error", {
        requestId: res.locals.requestId,
        type: error instanceof Error ? error.name : "unknown",
      });
      return res.status(503).json({
        code: "UNAVAILABLE",
        message: "Serviciul nu este disponibil momentan. Încearcă din nou.",
        retryable: true,
      });
    },
  );
  return app;
}
