"use client";
import { useEffect, useState } from "react";
import { getApp } from "firebase/app";
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  type Firestore,
} from "firebase/firestore";
import { staffAuth } from "./foundation";
import type { BookingRecord } from "./foundation-contracts";
let db: Firestore | undefined;
export function staffDb() {
  staffAuth();
  if (!db) {
    db = getFirestore(getApp("iasi-admin"));
    if (process.env.NEXT_PUBLIC_FIREBASE_USE_EMULATORS === "true")
      connectFirestoreEmulator(db, "127.0.0.1", 8088);
  }
  return db;
}
function dto(id: string, data: Record<string, unknown>) {
  const next = { ...data, id };
  for (const key of [
    "arrivalAt",
    "departureAt",
    "arrivedAt",
    "departedAt",
    "createdAt",
    "updatedAt",
  ]) {
    const v = data[key] as { toDate?: () => Date };
    next[key] = v?.toDate?.().toISOString() || null;
  }
  return next as BookingRecord;
}
export function useOperations(active: boolean, day: string) {
  const [rows, setRows] = useState<Record<string, BookingRecord[]>>({
    arrival: [],
    departure: [],
    parked: [],
  });
  const [stats, setStats] = useState({ arrivals: 0, departures: 0, parked: 0 });
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!active) return;
    let stops: (() => void)[] = [];
    const stop = () => {
      stops.forEach((fn) => fn());
      stops = [];
    };
    const start = () => {
      stop();
      if (document.visibilityState !== "visible") return;
      const db = staffDb();
      setError("");
      for (const kind of ["arrival", "departure", "parked"]) {
        const sort = kind === "arrival" ? "arrivalAt" : "departureAt";
        const constraints = [
          where("bookingStatus", "==", "confirmed"),
          where(
            "movementStatus",
            "==",
            kind === "arrival" ? "waiting" : "parked",
          ),
          ...(kind === "parked"
            ? []
            : [
                where(
                  kind === "arrival" ? "arrivalDay" : "departureDay",
                  "<=",
                  day,
                ),
              ]),
          orderBy(sort),
          limit(50),
        ];
        stops.push(
          onSnapshot(
            query(collection(db, "bookings"), ...constraints),
            (snapshot) => {
              setRows((old) => ({
                ...old,
                [kind]: snapshot.docs.map((s) => dto(s.id, s.data())),
              }));
              setReady(true);
            },
            (e) =>
              setError(
                e.code === "permission-denied"
                  ? "Accesul nu mai este activ."
                  : "Actualizarea în timp real este indisponibilă.",
              ),
          ),
        );
      }
      stops.push(
        onSnapshot(
          doc(db, "dailyStats", day),
          (s) =>
            setStats((old) => ({
              ...old,
              arrivals: s.data()?.arrivals || 0,
              departures: s.data()?.departures || 0,
            })),
          () => setError("Statisticile nu pot fi actualizate."),
        ),
      );
      stops.push(
        onSnapshot(
          doc(db, "liveStats", "parking"),
          (s) => setStats((old) => ({ ...old, parked: s.data()?.parked || 0 })),
          () => setError("Statisticile nu pot fi actualizate."),
        ),
      );
    };
    start();
    document.addEventListener("visibilitychange", start);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", start);
    };
  }, [active, day]);
  return { rows, stats, error, ready };
}
export function useStaffNotifications() {
  const [unread, setUnread] = useState(0),
    [sequence, setSequence] = useState(0),
    [denied, setDenied] = useState(false);
  const uid = staffAuth().currentUser?.uid;
  useEffect(() => {
    if (!uid) return;
    let stop = () => {};
    const start = () => {
      stop();
      if (document.visibilityState === "visible")
        stop = onSnapshot(
          doc(staffDb(), `users/${uid}/meta/notifications`),
          (s) => {
            setDenied(false);
            setUnread(s.data()?.unread || 0);
            setSequence(s.data()?.sequence || 0);
          },
          (error) => {
            if (error.code === "permission-denied") setDenied(true);
          },
        );
    };
    start();
    document.addEventListener("visibilitychange", start);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", start);
    };
  }, [uid]);
  return { unread, sequence, denied };
}

export function useStaffInbox(active: boolean) {
  const [items, setItems] = useState<
      import("./foundation-contracts").NotificationRecord[]
    >([]),
    [error, setError] = useState(""),
    [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<
    import("firebase/firestore").QueryDocumentSnapshot | null
  >(null);
  useEffect(() => {
    if (!active) return;
    const uid = staffAuth().currentUser?.uid;
    if (!uid) return;
    let stop = () => {};
    const start = () => {
      stop();
      if (document.visibilityState === "visible")
        stop = onSnapshot(
          query(
            collection(staffDb(), `users/${uid}/notifications`),
            orderBy("sequence", "desc"),
            limit(20),
          ),
          (snapshot) => {
            const recent = snapshot.docs.map((s) => {
              const d = s.data();
              return {
                ...d,
                id: s.id,
                createdAt: d.createdAt.toDate().toISOString(),
                readAt: d.readAt?.toDate().toISOString() || null,
              } as import("./foundation-contracts").NotificationRecord;
            });
            setItems((old) => {
              const map = new Map(old.map((n) => [n.id, n]));
              recent.forEach((n) => map.set(n.id, n));
              return [...map.values()].sort((a, b) => b.sequence - a.sequence);
            });
            setCursor((old) => old || snapshot.docs.at(-1) || null);
            setHasMore(snapshot.size === 20);
            setError("");
          },
          (error) => {
            if (error.code === "permission-denied") setItems([]);
            setError("Notificările nu pot fi actualizate.");
          },
        );
    };
    start();
    document.addEventListener("visibilitychange", start);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", start);
    };
  }, [active]);
  async function more() {
    const uid = staffAuth().currentUser?.uid;
    if (!uid || !cursor) return;
    try {
      const { getDocs, startAfter } = await import("firebase/firestore");
      const snapshot = await getDocs(
        query(
          collection(staffDb(), `users/${uid}/notifications`),
          orderBy("sequence", "desc"),
          startAfter(cursor),
          limit(20),
        ),
      );
      const next = snapshot.docs.map((s) => {
        const d = s.data();
        return {
          ...d,
          id: s.id,
          createdAt: d.createdAt.toDate().toISOString(),
          readAt: d.readAt?.toDate().toISOString() || null,
        } as import("./foundation-contracts").NotificationRecord;
      });
      setItems((old) => {
        const map = new Map(old.map((n) => [n.id, n]));
        next.forEach((n) => map.set(n.id, n));
        return [...map.values()].sort((a, b) => b.sequence - a.sequence);
      });
      setCursor(snapshot.docs.at(-1) || cursor);
      setHasMore(snapshot.size === 20);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Notificările nu pot fi încărcate.",
      );
    }
  }
  return { items, error, hasMore, more };
}
