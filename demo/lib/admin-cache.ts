"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { staffAuth, staffRequest } from "./foundation";
type Entry = { value: unknown; at: number; pending?: Promise<unknown> };
const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
export function clearAdminCache() {
  cache.clear();
  listeners.forEach((fn) => fn());
}
export function invalidateAdmin(paths: string[]) {
  for (const [key, entry] of cache)
    if (paths.some((path) => key.includes(path))) entry.at = 0;
  listeners.forEach((fn) => fn());
}
export function useAdminResource<T>(path: string | null, ttl = 30_000) {
  const uid = staffAuth().currentUser?.uid || "";
  const key = uid + ":" + path;
  const [state, setState] = useState<{
    key: string;
    data?: T;
    error: string;
    loading: boolean;
  }>({ key, error: "", loading: true });
  const generation = useRef(0);
  const load = useCallback(
    async (force = false) => {
      if (!path) return;
      const run = ++generation.current;
      let entry = cache.get(key);
      if (entry?.value)
        setState({ key, data: entry.value as T, error: "", loading: false });
      else setState({ key, error: "", loading: true });
      if (!force && entry && Date.now() - entry.at < ttl) return;
      try {
        if (!entry) {
          entry = { value: undefined, at: 0 };
          cache.set(key, entry);
        }
        const current = entry;
        if (!current.pending)
          current.pending = staffRequest<T>(path)
            .then((value) => {
              if (cache.get(key) === current) {
                current.value = value;
                current.at = Date.now();
              }
              return value;
            })
            .finally(() => {
              current.pending = undefined;
            });
        const value = (await current.pending) as T;
        if (run === generation.current)
          setState({ key, data: value, error: "", loading: false });
        if (cache.size > 60) cache.delete(cache.keys().next().value!);
      } catch (error) {
        if (run === generation.current)
          setState((previous) => ({
            ...previous,
            key,
            error:
              error instanceof Error ? error.message : "Date indisponibile.",
            loading: false,
          }));
      }
    },
    [path, key, ttl],
  );
  useEffect(() => {
    void load();
    const focus = () => {
      if (document.visibilityState === "visible") void load();
    };
    const refresh = () => void load();
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    listeners.add(refresh);
    return () => {
      ++generation.current;
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
      listeners.delete(refresh);
    };
  }, [load]);
  return {
    ...(state.key === key
      ? state
      : {
          key,
          data: cache.get(key)?.value as T | undefined,
          error: "",
          loading: true,
        }),
    refresh: () => load(true),
  };
}
