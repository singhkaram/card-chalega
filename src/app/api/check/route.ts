// POST /api/check {city, treatment} → NDJSON stream of CheckEvents (one per line).
import { z } from "zod";
import { clientIp, readJsonBody } from "@/lib/server/guards";
import { runCheck } from "@/lib/server/pipeline";
import { CITY_IDS, TREATMENT_IDS, type CheckEvent } from "@/types/domain";

export const runtime = "nodejs";
export const maxDuration = 60;
// Valid while Cache Components is off (next.config.ts); POST handlers are never cached anyway.
export const dynamic = "force-dynamic";

const Body = z.strictObject({
  city: z.enum(CITY_IDS),
  treatment: z.enum(TREATMENT_IDS),
});

const JSON_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request, Body, 2048);
  if (!body.ok) {
    return Response.json(
      { code: "INVALID_INPUT", message: "Pick a city and a treatment from the list." },
      { status: body.status, headers: JSON_HEADERS },
    );
  }

  // Aborts the pipeline when the client disconnects or the stream is cancelled.
  const cancelled = new AbortController();
  const signal = AbortSignal.any([request.signal, cancelled.signal]);
  const encoder = new TextEncoder();
  const ip = clientIp(request);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const emit = (event: CheckEvent): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          closed = true; // consumer is gone
        }
      };
      void (async () => {
        try {
          await runCheck({ ...body.data, ip, signal }, emit);
        } catch {
          // Never stream internals (stack traces, upstream messages) to the client.
          emit({ type: "error", code: "INTERNAL", message: "Something went wrong. Please try again." });
        } finally {
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        }
      })();
    },
    cancel() {
      cancelled.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
