import type { Request } from "express";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import type { ApiErrorCode, StaffSession } from "./contracts";
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}
export async function authenticate(req: Request): Promise<DecodedIdToken> {
  const match = req.header("authorization")?.match(/^Bearer (\S+)$/i);
  if (!match)
    throw new ApiError(
      401,
      "UNAUTHENTICATED",
      "Sesiunea a expirat. Reia autentificarea.",
    );
  try {
    return await getAuth().verifyIdToken(match[1]);
  } catch {
    throw new ApiError(
      401,
      "UNAUTHENTICATED",
      "Sesiunea a expirat. Reia autentificarea.",
    );
  }
}
export async function assertGuest(req: Request) {
  const token = await authenticate(req);
  if (
    token.firebase.sign_in_provider !== "anonymous" &&
    token.customerSession !== true
  )
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Această acțiune este disponibilă profilului guest.",
    );
  return token;
}
export async function staffSession(req: Request): Promise<StaffSession> {
  const token = await authenticate(req);
  if (!["admin", "operator"].includes(token.role))
    throw new ApiError(403, "FORBIDDEN", "Nu ai acces la administrare.");
  const bearer = req.header("authorization")!.match(/^Bearer (\S+)$/i)![1];
  try {
    await getAuth().verifyIdToken(bearer, true);
  } catch {
    throw new ApiError(401, "UNAUTHENTICATED", "Sesiunea a fost revocată.");
  }
  const access = await getFirestore().doc(`staffAccess/${token.uid}`).get();
  if (
    !access.exists ||
    access.get("enabled") !== true ||
    access.get("role") !== token.role
  )
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Accesul la administrare nu este activ.",
    );
  return { uid: token.uid, email: token.email || null, role: token.role };
}
