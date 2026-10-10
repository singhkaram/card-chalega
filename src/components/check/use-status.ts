"use client";

// GET /api/status, fetched once per page load and shared by every component
// that needs it (form badges, error states, refresh buttons).

import { useEffect, useState } from "react";
import type { CityId, StatusResponse, TreatmentId } from "@/types/domain";
import { isCityId, isRecord, isTreatmentId } from "@/lib/utils";

/** Defensive parse: unknown fields are ignored, bad combos dropped. */
export function parseStatus(raw: unknown): StatusResponse | null {
  if (!isRecord(raw)) return null;
  const combos: StatusResponse["combos"] = [];
  for (const c of Array.isArray(raw.combos) ? raw.combos : []) {
    if (!isRecord(c) || !isCityId(c.city) || !isTreatmentId(c.treatment)) continue;
    combos.push({
      city: c.city,
      treatment: c.treatment,
      fetchedAt: typeof c.fetchedAt === "string" ? c.fetchedAt : "",
      hospitals: typeof c.hospitals === "number" ? c.hospitals : 0,
    });
  }
  return {
    liveEnabled: raw.liveEnabled === true,
    llmEnabled: raw.llmEnabled === true,
    dataMode: raw.dataMode === "sample" ? "sample" : "snapshot",
    combos,
  };
}

let shared: Promise<StatusResponse | null> | null = null;

function loadStatus(): Promise<StatusResponse | null> {
  if (!shared) {
    shared = fetch("/api/status", { cache: "no-store", headers: { Accept: "application/json" } })
      .then(async (res) => (res.ok ? parseStatus(await res.json()) : null))
      .catch(() => null)
      .then((status) => {
        if (!status) shared = null; // allow a later retry
        return status;
      });
  }
  return shared;
}

export interface StatusState {
  status: StatusResponse | null;
  loading: boolean;
}

export function useStatus(): StatusState {
  const [state, setState] = useState<StatusState>({ status: null, loading: true });
  useEffect(() => {
    let alive = true;
    void loadStatus().then((status) => {
      if (alive) setState({ status, loading: false });
    });
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

export function isInstant(status: StatusResponse | null, city: CityId, treatment: TreatmentId): boolean {
  return Boolean(status?.combos.some((c) => c.city === city && c.treatment === treatment));
}
