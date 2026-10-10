// GET /api/status → what this server can do right now. Public: no secrets, no counts of credits.
import { isLlmConfigured } from "@/lib/ai/classifier";
import { readConfig } from "@/lib/server/guards";
import { readIndex } from "@/lib/server/store";
import { isCityId, isTreatmentId } from "@/lib/utils";
import { CITY_IDS, TREATMENT_IDS, type StatusResponse } from "@/types/domain";

export const runtime = "nodejs";
// Valid while Cache Components is off (next.config.ts): env and data files are read per request.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const cfg = readConfig();
  const index = await readIndex(cfg.dataMode);

  const combos: StatusResponse["combos"] = [];
  for (const c of Object.values(index?.combos ?? {})) {
    if (!isCityId(c.city) || !isTreatmentId(c.treatment)) continue;
    combos.push({
      city: c.city,
      treatment: c.treatment,
      fetchedAt: c.fetchedAt,
      hospitals: Array.isArray(c.hospitals) ? c.hospitals.length : 0,
    });
  }
  combos.sort((a, b) => CITY_IDS.indexOf(a.city) - CITY_IDS.indexOf(b.city) || TREATMENT_IDS.indexOf(a.treatment) - TREATMENT_IDS.indexOf(b.treatment));

  const body: StatusResponse = {
    // Sample mode never goes live, so the UI must not offer live features there.
    liveEnabled: cfg.liveEnabled && cfg.dataMode === "snapshot",
    llmEnabled: isLlmConfigured(),
    dataMode: cfg.dataMode,
    combos,
  };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
