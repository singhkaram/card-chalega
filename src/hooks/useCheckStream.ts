"use client";

// Client side of POST /api/check: reads the NDJSON stream, parses each line
// defensively and reduces CheckEvents into render state. The parser and the
// reducer are pure and exported for tests; the hook only does IO.

import { useCallback, useEffect, useReducer, useRef } from "react";
import type {
  CheckErrorCode,
  CheckEvent,
  CityBaseline,
  CityId,
  DataSource,
  Hospital,
  HospitalResult,
  HospitalScore,
  NewsItem,
  TreatmentId,
} from "@/types/domain";
import { isRecord } from "@/lib/utils";

export const STEP_ORDER = ["maps", "reviews", "classify", "score", "news"] as const;
export type StepId = (typeof STEP_ORDER)[number];

export interface StepState {
  state: "pending" | "active" | "complete" | "skipped" | "error";
  message?: string;
  done?: number;
  total?: number;
}

/** Server codes plus two the client detects itself. */
export type ClientErrorCode = CheckErrorCode | "NETWORK" | "INTERRUPTED";

export interface ClientError {
  code: ClientErrorCode;
  message: string;
  httpStatus?: number;
}

type MetaEvent = Extract<CheckEvent, { type: "meta" }>;
type DoneEvent = Extract<CheckEvent, { type: "done" }>;

export interface CheckStreamState {
  status: "idle" | "running" | "done" | "error";
  meta: Omit<MetaEvent, "type"> | null;
  progress: Record<StepId, StepState>;
  /** Most recent progress message (steps can run in parallel). */
  lastMessage: string | null;
  hospitals: Hospital[];
  hospitalsSource: DataSource | null;
  hospitalsFetchedAt: string | null;
  /** dataId → result, in arrival order. */
  results: Map<string, HospitalResult>;
  baseline: CityBaseline | null;
  scores: HospitalScore[];
  news: { items: NewsItem[]; source: DataSource; fetchedAt: string } | null;
  done: Omit<DoneEvent, "type"> | null;
  error: ClientError | null;
  /** dataId → ISO time of a successful single-hospital live refresh. */
  refreshedAt: Record<string, string>;
  /** Credits spent by refreshes after the run. */
  refreshCredits: number;
}

export type CheckStreamAction =
  | { type: "start" }
  | { type: "event"; event: CheckEvent }
  | { type: "fail"; error: ClientError }
  | { type: "replaceResult"; result: HospitalResult; creditsUsed: number; at: string };

function initialProgress(): Record<StepId, StepState> {
  return { maps: { state: "pending" }, reviews: { state: "pending" }, classify: { state: "pending" }, score: { state: "pending" }, news: { state: "pending" } };
}

export function initialCheckState(): CheckStreamState {
  return {
    status: "idle",
    meta: null,
    progress: initialProgress(),
    lastMessage: null,
    hospitals: [],
    hospitalsSource: null,
    hospitalsFetchedAt: null,
    results: new Map(),
    baseline: null,
    scores: [],
    news: null,
    done: null,
    error: null,
    refreshedAt: {},
    refreshCredits: 0,
  };
}

// ---------- line parsing ----------

const isStr = (v: unknown): v is string => typeof v === "string";

const STEP_SET: ReadonlySet<string> = new Set(STEP_ORDER);
const DATA_SOURCES: ReadonlySet<string> = new Set<DataSource>(["live", "cache", "snapshot", "sample"]);
const ERROR_CODES: ReadonlySet<string> = new Set<CheckErrorCode>([
  "INVALID_INPUT",
  "NOT_AVAILABLE_OFFLINE",
  "RATE_LIMITED",
  "CREDIT_CAP",
  "UPSTREAM",
  "NO_RESULTS",
  "INTERNAL",
]);

export function isCheckErrorCode(v: unknown): v is CheckErrorCode {
  return isStr(v) && ERROR_CODES.has(v);
}

function isDataSource(v: unknown): v is DataSource {
  return isStr(v) && DATA_SOURCES.has(v);
}

function isHospital(v: unknown): v is Hospital {
  return isRecord(v) && isStr(v.dataId) && isStr(v.name);
}

function isScore(v: unknown): v is HospitalScore {
  return isRecord(v) && isStr(v.dataId) && typeof v.n === "number" && isRecord(v.counts);
}

export function isHospitalResult(v: unknown): v is HospitalResult {
  return isRecord(v) && isHospital(v.hospital) && isScore(v.score) && Array.isArray(v.mentions);
}

function isNewsItem(v: unknown): v is NewsItem {
  return isRecord(v) && isStr(v.title) && isStr(v.link);
}

/**
 * Parses one NDJSON line into a CheckEvent. Returns null for blank lines,
 * malformed JSON, unknown event types or events missing required fields —
 * a bad line is skipped rather than breaking the whole stream.
 */
export function parseCheckEventLine(line: string): CheckEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !isStr(raw.type)) return null;
  const ev = raw;
  // Shapes come from our own server; checks cover what the reducer relies on.
  switch (ev.type) {
    case "meta":
      return isStr(ev.city) && isStr(ev.treatment) && isStr(ev.mode) ? (ev as unknown as CheckEvent) : null;
    case "progress":
      return isStr(ev.step) && STEP_SET.has(ev.step) ? (ev as unknown as CheckEvent) : null;
    case "hospitals":
      return Array.isArray(ev.hospitals) && isDataSource(ev.source)
        ? {
            type: "hospitals",
            hospitals: ev.hospitals.filter(isHospital),
            source: ev.source,
            fetchedAt: isStr(ev.fetchedAt) ? ev.fetchedAt : "",
          }
        : null;
    case "hospital":
      return isHospitalResult(ev.result) ? { type: "hospital", result: ev.result } : null;
    case "baseline":
      return isRecord(ev.baseline) && Array.isArray(ev.scores)
        ? { type: "baseline", baseline: ev.baseline as unknown as CityBaseline, scores: ev.scores.filter(isScore) }
        : null;
    case "news":
      return Array.isArray(ev.items) && isDataSource(ev.source)
        ? {
            type: "news",
            items: ev.items.filter(isNewsItem),
            source: ev.source,
            fetchedAt: isStr(ev.fetchedAt) ? ev.fetchedAt : "",
          }
        : null;
    case "done":
      return typeof ev.creditsUsed === "number" ? (ev as unknown as CheckEvent) : null;
    case "error":
      return isStr(ev.message)
        ? { type: "error", code: isCheckErrorCode(ev.code) ? ev.code : "INTERNAL", message: ev.message }
        : null;
    default:
      return null;
  }
}

/** Guard against a server that never sends a newline. */
const MAX_PENDING_CHARS = 4_000_000;

/**
 * Appends a decoded chunk to the pending partial line and returns every
 * complete line's event. The trailing partial line is carried over.
 */
export function parseNdjsonChunk(pending: string, chunk: string): { events: CheckEvent[]; pending: string } {
  const parts = (pending + chunk).split("\n");
  let rest = parts.pop() ?? "";
  if (rest.length > MAX_PENDING_CHARS) rest = "";
  const events: CheckEvent[] = [];
  for (const part of parts) {
    const ev = parseCheckEventLine(part);
    if (ev) events.push(ev);
  }
  return { events, pending: rest };
}

/** Maps a non-2xx response body ({code, message}) to a client error. */
export function errorFromHttp(httpStatus: number, body: unknown): ClientError {
  const rec = isRecord(body) ? body : {};
  const fallback: CheckErrorCode = httpStatus === 429 ? "RATE_LIMITED" : httpStatus === 400 || httpStatus === 422 ? "INVALID_INPUT" : "INTERNAL";
  const code = isCheckErrorCode(rec.code) ? rec.code : fallback;
  const message = isStr(rec.message) && rec.message.trim() ? rec.message : `The server responded with HTTP ${httpStatus}.`;
  return { code, message, httpStatus };
}

// ---------- reducer ----------

function unfinishedCounter(s: StepState): boolean {
  return s.total !== undefined && s.total > 0 && (s.done ?? 0) < s.total;
}

/**
 * Activates `step` and completes the steps before it — except an unfinished
 * "reviews" step when classification starts: the two overlap (hospital 3's
 * reviews load while hospital 2 is being classified).
 */
function advanceTo(progress: Record<StepId, StepState>, step: StepId, patch: StepState): Record<StepId, StepState> {
  const idx = STEP_ORDER.indexOf(step);
  const next = { ...progress };
  STEP_ORDER.forEach((id, i) => {
    if (i >= idx || !(next[id].state === "pending" || next[id].state === "active")) return;
    if (step === "classify" && id === "reviews" && next[id].state === "active" && unfinishedCounter(next[id])) return;
    next[id] = { ...next[id], state: "complete" };
  });
  next[step] = { ...next[step], ...patch };
  return next;
}

/** Completes `step` and everything before it (its data has arrived). */
function completeStep(progress: Record<StepId, StepState>, step: StepId): Record<StepId, StepState> {
  const idx = STEP_ORDER.indexOf(step);
  const next = { ...progress };
  STEP_ORDER.forEach((id, i) => {
    if (i <= idx && (next[id].state === "pending" || next[id].state === "active")) {
      next[id] = { ...next[id], state: "complete" };
    }
  });
  return next;
}

export function checkStreamReducer(state: CheckStreamState, action: CheckStreamAction): CheckStreamState {
  switch (action.type) {
    case "start":
      return { ...initialCheckState(), status: "running" };

    case "fail": {
      const progress = { ...state.progress };
      for (const id of STEP_ORDER) if (progress[id].state === "active") progress[id] = { ...progress[id], state: "error" };
      return { ...state, status: "error", error: action.error, progress };
    }

    case "replaceResult": {
      const results = new Map(state.results);
      results.set(action.result.hospital.dataId, action.result);
      return {
        ...state,
        results,
        refreshedAt: { ...state.refreshedAt, [action.result.hospital.dataId]: action.at },
        refreshCredits: state.refreshCredits + Math.max(0, action.creditsUsed),
      };
    }

    case "event":
      return applyEvent(state, action.event);

    default:
      return state;
  }
}

function applyEvent(state: CheckStreamState, ev: CheckEvent): CheckStreamState {
  switch (ev.type) {
    case "meta":
      return {
        ...state,
        status: "running",
        meta: { city: ev.city, treatment: ev.treatment, mode: ev.mode, llm: ev.llm === true, startedAt: ev.startedAt },
      };

    case "progress": {
      const finished = ev.total !== undefined && ev.total > 0 && ev.done !== undefined && ev.done >= ev.total;
      return {
        ...state,
        lastMessage: ev.message || state.lastMessage,
        progress: advanceTo(state.progress, ev.step, {
          state: finished ? "complete" : "active",
          message: ev.message,
          done: ev.done,
          total: ev.total,
        }),
      };
    }

    case "hospitals":
      return {
        ...state,
        hospitals: ev.hospitals,
        hospitalsSource: ev.source,
        hospitalsFetchedAt: ev.fetchedAt,
        progress: completeStep(state.progress, "maps"),
      };

    case "hospital": {
      const { result } = ev;
      const results = new Map(state.results);
      results.set(result.hospital.dataId, result);
      const known = state.hospitals.some((h) => h.dataId === result.hospital.dataId);
      return { ...state, results, hospitals: known ? state.hospitals : [...state.hospitals, result.hospital] };
    }

    case "baseline": {
      // Final scores carry the city delta; merge them into the cards. A card
      // refreshed live before this arrived keeps its newer score (the server
      // doesn't re-apply the baseline to refreshes either).
      const results = new Map(state.results);
      for (const score of ev.scores) {
        const existing = results.get(score.dataId);
        if (existing && !state.refreshedAt[score.dataId]) results.set(score.dataId, { ...existing, score });
      }
      return {
        ...state,
        results,
        baseline: ev.baseline,
        scores: ev.scores,
        progress: completeStep(state.progress, "score"),
      };
    }

    case "news":
      return {
        ...state,
        news: { items: ev.items, source: ev.source, fetchedAt: ev.fetchedAt },
        progress: completeStep(state.progress, "news"),
      };

    case "done": {
      const done = {
        creditsUsed: ev.creditsUsed,
        source: ev.source,
        oldestFetchedAt: ev.oldestFetchedAt ?? null,
        durationMs: ev.durationMs,
      };
      const progress = { ...state.progress };
      for (const id of STEP_ORDER) {
        const s = progress[id].state;
        if (s === "active") progress[id] = { ...progress[id], state: "complete" };
        else if (s === "pending") progress[id] = { ...progress[id], state: "skipped" };
      }
      return { ...state, status: "done", done, progress };
    }

    case "error":
      return checkStreamReducer(state, { type: "fail", error: { code: ev.code, message: ev.message } });

    default:
      return state;
  }
}

// ---------- hook ----------

async function readJsonSafely(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export interface UseCheckStream {
  state: CheckStreamState;
  /** Re-runs the check (aborts any run in flight). */
  retry: () => void;
  /** Swaps in a hospital result from POST /api/refresh. */
  replaceResult: (result: HospitalResult, creditsUsed: number) => void;
}

export function useCheckStream(city: CityId, treatment: TreatmentId): UseCheckStream {
  const [state, dispatch] = useReducer(checkStreamReducer, undefined, initialCheckState);
  const controllerRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal } = controller;
    dispatch({ type: "start" });

    try {
      const res = await fetch("/api/check", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({ city, treatment }),
        cache: "no-store",
        signal,
      });
      if (!res.ok) {
        dispatch({ type: "fail", error: errorFromHttp(res.status, await readJsonSafely(res)) });
        return;
      }
      if (!res.body) {
        dispatch({ type: "fail", error: { code: "INTERNAL", message: "The server sent an empty response." } });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        const chunk = done ? decoder.decode() + "\n" : decoder.decode(value, { stream: true });
        const parsed = parseNdjsonChunk(pending, chunk);
        pending = parsed.pending;
        for (const event of parsed.events) {
          if (signal.aborted) return;
          dispatch({ type: "event", event });
          if (event.type === "done" || event.type === "error") finished = true;
        }
        if (done) break;
      }
      if (!finished && !signal.aborted) {
        dispatch({
          type: "fail",
          error: { code: "INTERRUPTED", message: "The connection closed before the check finished." },
        });
      }
    } catch {
      if (signal.aborted) return;
      dispatch({
        type: "fail",
        error: { code: "NETWORK", message: "Could not reach the server. Check your connection and try again." },
      });
    }
  }, [city, treatment]);

  useEffect(() => {
    // Deferred start: React StrictMode mounts effects twice in development;
    // cancelling the timer in cleanup keeps it to a single request.
    const timer = setTimeout(() => void run(), 0);
    return () => {
      clearTimeout(timer);
      controllerRef.current?.abort();
    };
  }, [run]);

  const retry = useCallback(() => void run(), [run]);
  const replaceResult = useCallback((result: HospitalResult, creditsUsed: number) => {
    dispatch({ type: "replaceResult", result, creditsUsed, at: new Date().toISOString() });
  }, []);

  return { state, retry, replaceResult };
}
