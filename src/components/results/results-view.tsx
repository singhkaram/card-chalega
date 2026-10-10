"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, MessageCircle, Phone, Printer, SearchX } from "lucide-react";
import type { CityId, DataSource, TreatmentId } from "@/types/domain";
import { CITIES, HOSPITALS_PER_RUN, RIGHTS, TREATMENTS } from "@/config/presets";
import { useCheckStream, type CheckStreamState } from "@/hooks/useCheckStream";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useStatus } from "@/components/check/use-status";
import { cn } from "@/lib/utils";
import { BaselineStrip } from "./baseline-strip";
import { CopyButton } from "./copy-button";
import { ErrorState } from "./error-state";
import { HospitalCard } from "./hospital-card";
import { HowToRead } from "./how-to-read";
import { NewsBanner } from "./news-banner";
import { ProgressStepper } from "./progress-stepper";
import { RightsPanel } from "./rights-panel";
import { SampleBanner, SourceBadge } from "./source-badge";
import { orderResults, SORT_OPTIONS, type SortMode } from "./sort";
import { buildWhatsAppSummary, RESULTS_CAVEAT } from "./share";
import { formatIst, plural } from "./format";

/** "Snapshot fetched 05 Oct 2026, 14:10 IST · 0 searches used" / "Live · 11 searches used". */
export function runSourceLine(state: Pick<CheckStreamState, "done" | "hospitalsFetchedAt" | "refreshCredits">): string | null {
  const { done } = state;
  if (!done) return null;
  const credits = done.creditsUsed + state.refreshCredits;
  const used = `${credits} ${plural(credits, "search", "searches")} used`;
  const when = formatIst(done.oldestFetchedAt ?? state.hospitalsFetchedAt);
  switch (done.source) {
    case "live":
      return `Live · ${used}`;
    case "cache":
      return `Cached results${when ? ` fetched ${when}` : ""} · ${used}`;
    case "snapshot":
      return `Snapshot${when ? ` fetched ${when}` : ""} · ${used}`;
    case "sample":
      return `Sample data — not real · ${used}`;
  }
}

function CardSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-6" aria-hidden="true">
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="mt-2 h-4 w-1/2" />
      <Skeleton className="mt-5 h-4 w-full rounded-full" />
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Skeleton className="h-4" />
        <Skeleton className="h-4" />
        <Skeleton className="h-4" />
        <Skeleton className="h-4" />
      </div>
      <Skeleton className="mt-5 h-20 w-full" />
    </div>
  );
}

function SortControl({ value, onChange }: { value: SortMode; onChange: (k: SortMode) => void }) {
  return (
    <fieldset className="no-print flex flex-wrap items-center gap-2">
      <legend className="sr-only">Sort hospitals</legend>
      <span aria-hidden="true" className="text-sm text-muted-foreground">
        Sort:
      </span>
      {SORT_OPTIONS.map((o) => (
        <label
          key={o.key}
          className={cn(
            "inline-flex min-h-9 cursor-pointer items-center rounded-full border px-3 text-sm transition-colors",
            "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
            value === o.key
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-card text-foreground hover:bg-muted",
          )}
        >
          <input
            type="radio"
            name="sort"
            value={o.key}
            checked={value === o.key}
            onChange={() => onChange(o.key)}
            className="sr-only"
          />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

interface ResultsViewProps {
  city: CityId;
  treatment: TreatmentId;
}

export function ResultsView({ city, treatment }: ResultsViewProps) {
  const { state, retry, replaceResult } = useCheckStream(city, treatment);
  const { status } = useStatus();
  const [sort, setSort] = useState<SortMode>("evidence");

  const cityInfo = CITIES[city];
  const treatmentInfo = TREATMENTS[treatment];
  const heading = `${cityInfo.name} · ${treatmentInfo.label}`;

  const results = useMemo(
    () => orderResults(state.results.values(), state.hospitals, sort),
    [state.results, state.hospitals, sort],
  );
  const running = state.status === "running" || state.status === "idle";
  const pending = Math.max(0, state.hospitals.length - state.results.size);
  const skeletons = running ? (state.hospitals.length > 0 ? pending : Math.min(3, HOSPITALS_PER_RUN)) : 0;

  const source: DataSource | null = state.hospitalsSource ?? state.meta?.mode ?? null;
  const fetchedAt = state.hospitalsFetchedAt || state.done?.oldestFetchedAt || null;
  const isSample = source === "sample" || state.meta?.mode === "sample" || state.done?.source === "sample";
  const sourceLine = runSourceLine(state);
  const cityMedian = state.baseline?.medianAyushmanRating ?? null;
  const empty = state.status === "done" && state.results.size === 0;

  // Shared text uses the neutral "most evidence" order, not the on-screen sort.
  const whatsappText = () =>
    buildWhatsAppSummary({
      heading,
      results: orderResults(state.results.values(), state.hospitals, "evidence"),
      sourceLine: sourceLine ?? (isSample ? "Sample data — not real." : "Data via SerpApi."),
      url: typeof window !== "undefined" ? window.location.href : "",
    });

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      {isSample ? <SampleBanner /> : null}

      {/* ---------- heading ---------- */}
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <Link
            href={`/?city=${city}&treatment=${treatment}#check`}
            className="no-print inline-flex min-h-8 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Change search
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">{heading}</h1>
          <p lang="hi" className="text-muted-foreground">
            {cityInfo.nameHi} · {treatmentInfo.labelHi}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <SourceBadge source={source} fetchedAt={fetchedAt} waiting={running} />
          </div>
          <p role="note" className="mt-2 max-w-prose text-sm text-muted-foreground">
            {RESULTS_CAVEAT}{" "}
            <Link href="/methodology" className="underline underline-offset-4 hover:text-foreground">
              How the numbers are made
            </Link>
          </p>
        </div>
        <div className="no-print flex flex-wrap gap-2">
          <HowToRead />
          <CopyButton
            text={whatsappText}
            label="Copy WhatsApp summary"
            copiedLabel="Summary copied"
            icon={<MessageCircle aria-hidden="true" />}
            disabled={results.length === 0}
          />
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            <Printer aria-hidden="true" />
            Print
          </Button>
        </div>
      </div>

      {/* ---------- progress + errors ---------- */}
      <div className="mt-6 flex flex-col gap-4">
        <ProgressStepper state={state} />
        {state.error ? (
          <ErrorState error={state.error} city={city} treatment={treatment} status={status} onRetry={retry} />
        ) : null}
      </div>

      {/* Phones: the rights panel sits below every card, so surface the helpline here. A repeat
          tap on the same hash fires no hashchange, so the link nudges the panel to open anyway. */}
      <p className="no-print mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-secondary/60 px-3 py-2 text-sm lg:hidden">
        <span className="inline-flex flex-wrap items-center gap-x-1.5">
          <Phone className="size-4" aria-hidden="true" />
          Refused or asked to pay?{" "}
          <a href={`tel:${RIGHTS.helpline}`} className="font-semibold tabular-nums underline underline-offset-4">
            Call {RIGHTS.helpline}
          </a>{" "}
          (PM-JAY, toll-free)
        </span>
        <a
          href="#rights"
          onClick={() => window.dispatchEvent(new HashChangeEvent("hashchange"))}
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Your rights &amp; complaint portal
        </a>
      </p>

      {/* ---------- results + rights ---------- */}
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <section aria-labelledby="hospitals-heading" className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="hospitals-heading" className="text-lg font-semibold">
              {state.results.size > 0
                ? `${state.results.size} ${plural(state.results.size, "hospital", "hospitals")} compared`
                : state.status === "error"
                  ? "No results to show"
                  : running
                    ? "Hospitals"
                    : "0 hospitals compared"}
              {running && state.hospitals.length > 0 ? (
                <span className="font-normal text-muted-foreground"> · {pending} still loading</span>
              ) : null}
            </h2>
            {results.length > 1 ? <SortControl value={sort} onChange={setSort} /> : null}
          </div>

          <BaselineStrip baseline={state.baseline} cityName={cityInfo.name} waiting={running} />

          {results.length > 0 || skeletons > 0 ? (
            <ul className="flex flex-col gap-4">
              {results.map((r) => (
                <li key={r.hospital.dataId}>
                  <HospitalCard
                    result={r}
                    city={city}
                    treatment={treatment}
                    cityMedian={cityMedian}
                    llmEnabled={state.meta?.llm}
                    liveEnabled={status?.liveEnabled === true}
                    refreshedAt={state.refreshedAt[r.hospital.dataId]}
                    windowReference={state.meta?.startedAt}
                    onReplace={replaceResult}
                  />
                </li>
              ))}
              {Array.from({ length: skeletons }, (_, i) => (
                <li key={`skeleton-${i}`}>
                  <CardSkeleton />
                </li>
              ))}
            </ul>
          ) : null}

          {empty && !state.error ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-input p-8 text-center">
              <SearchX className="size-8 text-muted-foreground" aria-hidden="true" />
              <p className="font-semibold">No hospitals found for {treatmentInfo.label.toLowerCase()} near {cityInfo.name}</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Google Maps returned no hospitals that match this treatment. Try “Any treatment” or another city.
              </p>
              <Button asChild variant="outline" size="sm">
                <Link href={`/?city=${city}#check`}>Change search</Link>
              </Button>
            </div>
          ) : null}

          <NewsBanner news={state.news} cityName={cityInfo.name} />
        </section>

        <RightsPanel treatment={treatment} />
      </div>

      <p className="mt-8 text-sm text-muted-foreground" aria-live="off">
        {sourceLine ?? (state.status === "error" ? "Check incomplete." : "Fetching…")}
      </p>
    </div>
  );
}
