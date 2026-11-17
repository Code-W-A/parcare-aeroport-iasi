import express from "express";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import { z } from "zod";
import type { GuestProfile } from "./contracts";
import { ApiError, assertGuest, staffSession } from "./access";
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
    email: data.email,
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
    res.set("Cache-Control", "private, no-store");
    const allowed = (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .filter(Boolean);
    const origin = req.header("origin");
    if (origin && !allowed.includes(origin))
      return res
        .status(403)
        .json({
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
        const updated = {
          ...patch,
          revision: expectedRevision + 1,
          updatedAt: Timestamp.now(),
        };
        transaction.update(ref, updated);
        return { ...snapshot.data()!, ...updated };
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
    res
      .status(404)
      .json({
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
        return res
          .status(400)
          .json({
            code: "VALIDATION_ERROR",
            message: "Verifică datele completate.",
            retryable: false,
          });
      }
      if (error instanceof ApiError)
        return res
          .status(error.status)
          .json({
            code: error.code,
            message: error.message,
            retryable: error.status >= 500,
          });
      console.error("api_error", {
        type: error instanceof Error ? error.name : "unknown",
      });
      return res
        .status(503)
        .json({
          code: "UNAVAILABLE",
          message: "Serviciul nu este disponibil momentan. Încearcă din nou.",
          retryable: true,
        });
    },
  );
  return app;
}
