import { startTransition, useEffect, useEffectEvent, useState } from "react";
import type {
  DashboardEventType,
  DashboardJournalRow,
  DashboardSnapshotResponse,
} from "./dashboard-types";

export async function fetchJson<T>(input: string): Promise<T> {
  const response = await fetch(input);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

interface PollingState<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
}

export function usePollingJson<T>(
  url: string | null,
  intervalMs: number,
): PollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useEffectEvent(async () => {
    if (!url) return;
    try {
      const next = await fetchJson<T>(url);
      startTransition(() => {
        setData(next);
        setError(null);
        setIsLoading(false);
      });
    } catch (err) {
      startTransition(() => {
        setError(err instanceof Error ? err.message : String(err));
        setIsLoading(false);
      });
    }
  });

  useEffect(() => {
    if (!url) return;
    setIsLoading(true);
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, url]);

  return { data, isLoading, error };
}

export function useDashboardSnapshot(): PollingState<DashboardSnapshotResponse> {
  return usePollingJson<DashboardSnapshotResponse>(
    "/api/dashboard/snapshot",
    1_000,
  );
}

export function useJournalRows(
  coin: string | "ALL" | null,
  eventType: DashboardEventType | "ALL",
  limit = 200,
) {
  const params = new URLSearchParams();
  let url: string | null = null;
  if (coin !== null) {
    if (coin !== "ALL") params.set("coin", coin);
    if (eventType !== "ALL") params.set("eventType", eventType);
    params.set("limit", String(limit));
    url = `/api/dashboard/journal?${params.toString()}`;
  }
  return usePollingJson<{ rows: DashboardJournalRow[] }>(url, 5_000);
}
