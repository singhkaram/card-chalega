// POST /api/refresh {city, treatment, dataId} → 1-credit live refresh of one hospital's reviews.
import { z } from "zod";
import { clientIp, readJsonBody } from "@/lib/server/guards";
import { runRefresh } from "@/lib/server/pipeline";
import { CITY_IDS, TREATMENT_IDS, type RefreshResponse } from "@/types/domain";

export const runtime = "nodejs";
export const maxDuration = 60;
// Valid while Cache Components is off (next.config.ts); POST handlers are never cached anyway.
export const dynamic = "force-dynamic";

const Body = z.strictObject({
  city: z.enum(CITY_IDS),
  treatment: z.enum(TREATMENT_IDS),
  // Shape check only; membership in the combo is verified by runRefresh.
  dataId: z.string().regex(/^0x[0-9a-f]{1,16}:0x[0-9a-f]{1,16}$/i),
});

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request, Body, 2048);
  if (!body.ok) {
    const invalid: RefreshResponse = { ok: false, code: "INVALID_INPUT", message: "Invalid refresh request." };
    return Response.json(invalid, { status: body.status, headers: HEADERS });
  }

  let result: RefreshResponse;
  try {
    result = await runRefresh({ ...body.data, ip: clientIp(request), signal: request.signal });
  } catch {
    result = { ok: false, code: "INTERNAL", message: "Something went wrong. Please try again." };
  }
  // Business outcomes (offline, rate limited, cap) are 200 with ok:false; only bad input is 4xx.
  const status = !result.ok && result.code === "INVALID_INPUT" ? 400 : 200;
  return Response.json(result, { status, headers: HEADERS });
}
