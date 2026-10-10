"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Bot,
  ChevronDown,
  ExternalLink,
  Info,
  Landmark,
  LoaderCircle,
  MapPin,
  Phone,
  RefreshCw,
  Sparkles,
  Star,
} from "lucide-react";
import type { CityId, ClassifierKind, HospitalResult, TreatmentId } from "@/types/domain";
import { TREATMENTS } from "@/config/presets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EvidenceBar } from "./evidence-bar";
import { RatingSplit } from "./rating-split";
import { MentionQuote } from "./mention-quote";
import { CopyButton } from "./copy-button";
import { evidenceSummary, MIN_N_FOR_LABEL, WINDOW_MONTHS } from "@/lib/scoring/score";
import {
  LABEL_TEXT,
  classifierOf,
  isOutsideWindow,
  orderAllMentions,
  pickTopQuotes,
  uncountedMentions,
} from "./evidence";
import { formatCount, formatIst, plural, safeExternalUrl } from "./format";
import { buildCallScript, callScriptText } from "./share";
import { refreshHospital } from "./refresh";

interface HospitalCardProps {
  result: HospitalResult;
  city: CityId;
  treatment: TreatmentId;
  cityMedian: number | null;
  llmEnabled?: boolean;
  liveEnabled: boolean;
  /** ISO time of a live refresh in this session, if any. */
  refreshedAt?: string;
  /** Reference time for the 24-month window (the run's start); defaults to now. */
  windowReference?: string;
  onReplace: (result: HospitalResult, creditsUsed: number) => void;
}

function sourceText(result: HospitalResult, refreshedAt?: string): string {
  if (refreshedAt) return "Live · just now";
  const when = formatIst(result.reviewsFetchedAt);
  switch (result.source) {
    case "live":
      return when ? `Live · fetched ${when}` : "Live";
    case "cache":
      return when ? `Reviews cached · fetched ${when}` : "Reviews cached";
    case "snapshot":
      return when ? `Reviews snapshot fetched ${when}` : "Reviews snapshot";
    case "sample":
      return "Sample data — not real";
  }
}

/**
 * Info button that reveals its explanation on tap or click (a tooltip never
 * opens on touch). The paragraph is basis-full, so inside a flex-wrap row it
 * opens on its own line.
 */
function InfoToggle({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="no-print inline-flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Info className="size-3.5" aria-hidden="true" />
      </button>
      <p id={panelId} hidden={!open} className="basis-full text-xs leading-relaxed text-muted-foreground">
        {text}
      </p>
    </>
  );
}

function ClassifierBadge({ kind }: { kind: ClassifierKind }) {
  const llm = kind === "llm";
  return (
    <>
      <Badge variant={llm ? "secondary" : "warning"}>
        {llm ? <Sparkles aria-hidden="true" /> : <Bot aria-hidden="true" />}
        {llm ? "AI-classified" : "Rule-based (AI unavailable)"}
      </Badge>
      <InfoToggle
        label={llm ? "About AI classification" : "About the rule-based fallback"}
        text={
          llm
            ? "Claude sorted each review into one of 9 classes and cited the sentences it used. Quotes, counts and labels are built by code."
            : "The AI classifier was unavailable, so a keyword-based fallback sorted these reviews. It is more cautious and marks more reviews as “mentions only”."
        }
      />
    </>
  );
}

function telHref(phone: string): string | null {
  const digits = phone.replace(/[^\d+]/g, "");
  return digits.length >= 6 ? `tel:${digits}` : null;
}

export function HospitalCard({
  result,
  city,
  treatment,
  cityMedian,
  llmEnabled,
  liveEnabled,
  refreshedAt,
  windowReference,
  onReplace,
}: HospitalCardProps) {
  const { hospital, score, mentions } = result;
  const id = useId();
  const headingId = `${id}-name`;
  const listId = `${id}-all`;
  const [showAll, setShowAll] = useState(false);
  const [refresh, setRefresh] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  // A refreshed card was scored at refresh time, not at the run's start.
  const reference = refreshedAt ?? windowReference;
  const top = useMemo(() => pickTopQuotes(mentions, reference), [mentions, reference]);
  const all = useMemo(() => orderAllMentions(mentions, reference), [mentions, reference]);
  const tooFew = score.n < MIN_N_FOR_LABEL;
  const overall = score.overallRating ?? hospital.rating ?? null;
  const mapsUrl = safeExternalUrl(hospital.mapsUrl);
  const phoneHref = hospital.phone ? telHref(hospital.phone) : null;
  const treatmentInfo = TREATMENTS[treatment];
  const kind = classifierOf(mentions, llmEnabled);

  // The list holds every matching review; n (from the server) counts only the
  // in-window ones about the scheme. Say so when the two differ.
  const total = mentions.length;
  const allCounted = total === score.n;
  const showAllLabel = allCounted
    ? `Show all ${total} ${plural(total, "report", "reports")}`
    : `Show all ${total} matching ${plural(total, "review", "reviews")} (${score.n} counted)`;
  const { notAboutScheme, older } = uncountedMentions(mentions, reference);
  // Only explain the gap when the client-side split adds up to the server's n.
  const uncounted =
    !allCounted && notAboutScheme + older === total - score.n
      ? [
          notAboutScheme > 0 ? `${notAboutScheme} not about the scheme` : "",
          older > 0 ? `${older} older than ${WINDOW_MONTHS} months` : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
  // One page of reviews (newest first) is read per hospital; the server flags
  // when Google had more. Optional on the wire: older payloads lack it.
  const moreOnGoogle = result.moreReviews === true;

  // A retry clears the results and unmounts every card; a refresh that
  // resolves after that must not leak an old run's card into the new one.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true; // StrictMode re-runs effects after a cleanup
    return () => {
      alive.current = false;
    };
  }, []);

  async function onRefresh() {
    setRefresh({ busy: true, error: null });
    const res = await refreshHospital(city, treatment, hospital.dataId);
    if (!alive.current) return;
    if (res.ok) {
      onReplace(res.result, res.creditsUsed);
      setRefresh({ busy: false, error: null });
    } else {
      setRefresh({ busy: false, error: res.message });
    }
  }

  return (
    <article
      aria-labelledby={headingId}
      aria-busy={refresh.busy || undefined}
      className="animate-enter rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm sm:p-6"
    >
      {/* ---------- identity ---------- */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 id={headingId} className="break-words text-lg font-semibold leading-snug">
            {hospital.name}
          </h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {hospital.isGovernment ? (
              <Badge variant="info">
                <Landmark aria-hidden="true" />
                Govt
              </Badge>
            ) : null}
            {!tooFew ? (
              <Badge variant="outline">
                {LABEL_TEXT[score.label]} (n={score.n})
              </Badge>
            ) : null}
            {hospital.nameCollision ? (
              <>
                <Badge variant="muted">Name contains “Ayushman” — filtered</Badge>
                <InfoToggle
                  label="About the name filter"
                  text="This hospital's own name contains “Ayushman”, so reviews count only when they clearly refer to the PM-JAY card or scheme."
                />
              </>
            ) : null}
          </div>
          {hospital.address ? (
            <p className="mt-2 flex gap-1.5 text-sm text-muted-foreground">
              <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span className="break-words">{hospital.address}</span>
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-row flex-wrap items-baseline gap-x-3 gap-y-1 sm:flex-col sm:items-end">
          {overall !== null ? (
            <p className="inline-flex items-center gap-1 text-xl font-semibold tabular-nums">
              {overall.toFixed(1)}
              <Star className="size-4 fill-star text-star" aria-hidden="true" />
              <span className="sr-only">out of 5 overall on Google Maps</span>
            </p>
          ) : null}
          {hospital.reviewCount ? (
            <p className="text-xs text-muted-foreground">
              {formatCount(hospital.reviewCount)} Google {plural(hospital.reviewCount, "review", "reviews")}
            </p>
          ) : null}
          {mapsUrl ? (
            <a
              href={mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="print-url inline-flex min-h-6 items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              Google Maps
              <ExternalLink className="size-3.5" aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : null}
        </div>
      </header>

      {/* ---------- rating split ---------- */}
      {score.ayushmanRating !== null ? (
        <div className="mt-4">
          <RatingSplit score={score} overallRating={overall} reviewCount={hospital.reviewCount} cityMedian={cityMedian} />
        </div>
      ) : null}

      {/* ---------- evidence ---------- */}
      <div className="mt-4 flex flex-col gap-3">
        {tooFew ? (
          <div className="rounded-lg border border-dashed border-input p-4">
            <p className="font-medium">
              Too few reports to compare <span className="font-normal text-muted-foreground">(n={score.n})</span>
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {score.n === 0
                ? `No reviews from the last ${WINDOW_MONTHS} months describe using an Ayushman card here.`
                : `Only ${score.n} ${plural(score.n, "review", "reviews")} from the last ${WINDOW_MONTHS} months ${plural(score.n, "describes", "describe")} using an Ayushman card here.`}{" "}
              Call ahead before you go.
            </p>
            <div className="no-print mt-3 flex flex-wrap gap-2">
              {phoneHref ? (
                <Button asChild variant="outline" size="sm">
                  <a href={phoneHref}>
                    <Phone aria-hidden="true" />
                    Call {hospital.phone}
                  </a>
                </Button>
              ) : null}
              <CopyButton
                variant="secondary"
                text={() => callScriptText(buildCallScript(treatmentInfo))}
                label="Copy call-ahead script"
                copiedLabel="Script copied"
              />
            </div>
          </div>
        ) : (
          <>
            <EvidenceBar score={score} />
            <p className="text-sm">{evidenceSummary(score)}</p>
          </>
        )}
        {treatment !== "general" && score.n > 0 ? (
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Treatment-specific:</span> {score.treatmentMentions.k} of{" "}
            {score.treatmentMentions.n} {plural(score.treatmentMentions.n, "report mentions", "reports mention")}{" "}
            {treatmentInfo.label.toLowerCase()}.
          </p>
        ) : null}
      </div>

      {/* ---------- quotes ---------- */}
      {!tooFew && top.length > 0 ? (
        <section className="mt-5" aria-labelledby={`${id}-quotes`}>
          <h4 id={`${id}-quotes`} className="text-sm font-semibold">
            What reviewers report
          </h4>
          <ul className="mt-2 flex flex-col gap-3">
            {top.map((m) => (
              <li key={m.reviewId}>
                <MentionQuote mention={m} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {mentions.length > 0 ? (
        <div className="mt-3">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={showAll}
            aria-controls={listId}
            onClick={() => setShowAll((v) => !v)}
            className="-ml-2 text-primary"
          >
            <ChevronDown className={cn("transition-transform", showAll && "rotate-180")} aria-hidden="true" />
            {showAll ? (allCounted ? "Hide reports" : "Hide reviews") : showAllLabel}
          </Button>
          {uncounted ? <p className="text-xs text-muted-foreground">Not counted: {uncounted}</p> : null}
          {moreOnGoogle ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Google has more reviews mentioning Ayushman here; we read the {total} newest.
            </p>
          ) : null}
          <ul id={listId} hidden={!showAll} className="mt-2 flex flex-col gap-3">
            {showAll
              ? all.map((m) => (
                  <li key={m.reviewId}>
                    <MentionQuote mention={m} older={isOutsideWindow(m, reference)} />
                  </li>
                ))
              : null}
          </ul>
        </div>
      ) : null}

      {/* ---------- provenance ---------- */}
      <footer className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-3 text-xs text-muted-foreground">
        <ClassifierBadge kind={kind} />
        <span className={cn(refreshedAt && "font-medium text-foreground")}>{sourceText(result, refreshedAt)}</span>
        {liveEnabled ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={refresh.busy}
            className="no-print ml-auto h-8 text-xs"
          >
            {refresh.busy ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw aria-hidden="true" />
            )}
            {refresh.busy ? "Refreshing…" : "Refresh live (1 search)"}
          </Button>
        ) : null}
        {refresh.error ? (
          <p role="alert" className="w-full text-xs text-warning-foreground">
            Refresh failed: {refresh.error}
          </p>
        ) : null}
      </footer>
    </article>
  );
}
