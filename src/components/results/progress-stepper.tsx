import { CircleCheck, CircleDashed, LoaderCircle, TriangleAlert } from "lucide-react";
import { STEP_ORDER, type CheckStreamState, type StepId, type StepState } from "@/hooks/useCheckStream";
import { HOSPITALS_PER_RUN } from "@/config/presets";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { runClassifierOf } from "./evidence";

const STATE_TEXT: Record<StepState["state"], string> = {
  pending: "waiting",
  active: "in progress",
  complete: "done",
  skipped: "skipped",
  error: "stopped",
};

function stepLabel(id: StepId, step: StepState, llm: boolean | undefined): string {
  switch (id) {
    case "maps":
      return "Maps";
    case "reviews": {
      const total = step.total ?? HOSPITALS_PER_RUN;
      return step.done !== undefined ? `Reviews ${step.done}/${total}` : "Reviews";
    }
    case "classify":
      return llm === undefined ? "Classify" : llm ? "AI classify" : "Keyword classify";
    case "score":
      return "Scores";
    case "news":
      return "News";
  }
}

const DEFAULT_MESSAGE: Record<StepId, string> = {
  maps: "Finding hospitals on Google Maps…",
  reviews: "Reading reviews that mention “ayushman”…",
  classify: "Classifying each report into what happened…",
  score: "Counting reports and comparing with the city…",
  news: "Checking recent news…",
};

function StepIcon({ state }: { state: StepState["state"] }) {
  const cls = "size-5 shrink-0";
  switch (state) {
    case "complete":
      return <CircleCheck className={cn(cls, "text-primary")} aria-hidden="true" />;
    case "active":
      return <LoaderCircle className={cn(cls, "animate-spin text-primary")} aria-hidden="true" />;
    case "error":
      return <TriangleAlert className={cn(cls, "text-warning-foreground")} aria-hidden="true" />;
    case "skipped":
      return <CircleDashed className={cn(cls, "text-muted-foreground")} aria-hidden="true" />;
    default:
      return <span className={cn(cls, "rounded-full border-2 border-input")} aria-hidden="true" />;
  }
}

interface ProgressStepperProps {
  state: Pick<CheckStreamState, "status" | "progress" | "lastMessage" | "meta" | "done" | "results" | "hospitals">;
}

/**
 * Maps → Reviews x/8 → Classify → Scores → News, announced politely. The
 * classify step gains "AI" / "Keyword" only from evidence (classified results,
 * or meta.llm once the run is done), so it never shows a guess and then flips.
 */
export function ProgressStepper({ state }: ProgressStepperProps) {
  const { progress, status } = state;
  const kind = runClassifierOf(state.results.values(), status === "done" ? state.meta?.llm : undefined);
  const llm = kind === undefined ? undefined : kind === "llm";
  const active = STEP_ORDER.find((id) => progress[id].state === "active");
  const reviews = progress.reviews;
  const reviewTotal = reviews.total ?? (state.hospitals.length || HOSPITALS_PER_RUN);

  let message: string;
  if (status === "done") {
    const secs = state.done ? (state.done.durationMs / 1000).toFixed(1) : null;
    message = `Done — ${state.results.size} ${state.results.size === 1 ? "hospital" : "hospitals"} compared${secs ? ` in ${secs} s` : ""}.`;
  } else if (status === "error") {
    message = "The check stopped before it finished.";
  } else if (state.lastMessage) {
    message = state.lastMessage;
  } else if (active) {
    message = progress[active].message || DEFAULT_MESSAGE[active];
  } else {
    message = "Starting…";
  }

  return (
    <section aria-label="Check progress" className="no-print rounded-xl border border-border bg-card p-4 shadow-sm">
      <ol className="grid grid-cols-5 gap-1 sm:gap-2">
        {STEP_ORDER.map((id, i) => {
          const step = progress[id];
          return (
            <li
              key={id}
              className={cn(
                "relative flex flex-col items-center gap-1.5 text-center text-[11px] leading-tight sm:flex-row sm:text-left sm:text-sm",
                step.state === "pending" || step.state === "skipped" ? "text-muted-foreground" : "text-foreground",
                step.state === "active" && "font-semibold",
              )}
            >
              <StepIcon state={step.state} />
              <span>
                {stepLabel(id, step, llm)}
                {id === "classify" && llm === false ? <span className="sr-only"> (AI unavailable)</span> : null}
                <span className="sr-only"> ({STATE_TEXT[step.state]})</span>
              </span>
              {i < STEP_ORDER.length - 1 ? (
                <span aria-hidden="true" className="ml-auto hidden h-px flex-1 bg-border lg:block" />
              ) : null}
            </li>
          );
        })}
      </ol>
      {status === "running" && reviews.state === "active" ? (
        <Progress className="mt-3" value={reviews.done ?? 0} max={reviewTotal} label="Hospitals whose reviews have been read" />
      ) : null}
      <p className="mt-3 min-h-5 text-sm text-muted-foreground" role="status" aria-live="polite">
        {message}
      </p>
    </section>
  );
}
