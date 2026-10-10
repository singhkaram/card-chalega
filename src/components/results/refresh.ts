// Client call for POST /api/refresh (1-credit live refresh of one hospital).

import type { CityId, RefreshResponse, TreatmentId } from "@/types/domain";
import { isCheckErrorCode, isHospitalResult } from "@/hooks/useCheckStream";

export function parseRefreshResponse(raw: unknown): RefreshResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.ok === true && isHospitalResult(rec.result)) {
    return { ok: true, result: rec.result, creditsUsed: typeof rec.creditsUsed === "number" ? rec.creditsUsed : 1 };
  }
  if (rec.ok === false || typeof rec.message === "string") {
    return {
      ok: false,
      code: isCheckErrorCode(rec.code) ? rec.code : "INTERNAL",
      message: typeof rec.message === "string" ? rec.message : "Refresh failed.",
    };
  }
  return null;
}

export async function refreshHospital(city: CityId, treatment: TreatmentId, dataId: string): Promise<RefreshResponse> {
  try {
    const res = await fetch("/api/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ city, treatment, dataId }),
      cache: "no-store",
    });
    const parsed = parseRefreshResponse(await res.json().catch(() => null));
    if (parsed) return parsed;
    return { ok: false, code: "INTERNAL", message: `Refresh failed (HTTP ${res.status}).` };
  } catch {
    return { ok: false, code: "INTERNAL", message: "Could not reach the server." };
  }
}
