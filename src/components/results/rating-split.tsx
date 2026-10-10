import type { HospitalScore } from "@/types/domain";
import { describeDelta, displayedDelta, formatCount, formatStars } from "./format";

interface RatingSplitProps {
  score: HospitalScore;
  overallRating: number | null;
  reviewCount?: number;
  cityMedian: number | null;
}

const pos = (r: number) => `${((Math.min(Math.max(r, 1), 5) - 1) / 4) * 100}%`;

/**
 * "Overall 4.6★ (2,341) · Ayushman-mentioning reviews 2.0★ (n=9) · city median 3.3★".
 * Shown only when the score has a rating split (n ≥ 5). The 1–5 strip below is
 * decorative; the sentence carries every number. The delta is taken from the
 * two rounded ratings printed beside it, so the subtraction checks out on screen.
 */
export function RatingSplit({ score, overallRating, reviewCount, cityMedian }: RatingSplitProps) {
  const ayushman = score.ayushmanRating;
  if (ayushman === null) return null;
  const delta = cityMedian !== null ? displayedDelta(ayushman, cityMedian) : null;

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3 sm:p-4">
      <p className="text-sm leading-relaxed">
        {overallRating !== null ? (
          <>
            <span className="whitespace-nowrap">
              Overall <strong className="font-semibold">{formatStars(overallRating)}</strong>
              {reviewCount ? <span className="text-muted-foreground"> ({formatCount(reviewCount)})</span> : null}
            </span>
            <span aria-hidden="true" className="text-muted-foreground"> · </span>
          </>
        ) : null}
        <span>
          Ayushman-mentioning reviews <strong className="font-semibold">{formatStars(ayushman)}</strong>{" "}
          <span className="text-muted-foreground">(n={score.n})</span>
        </span>
        {cityMedian !== null ? (
          <>
            <span aria-hidden="true" className="text-muted-foreground"> · </span>
            <span className="whitespace-nowrap">city median {formatStars(cityMedian)}</span>
          </>
        ) : null}
      </p>
      {delta !== null ? <p className="mt-1 text-sm font-medium">{describeDelta(delta)}</p> : null}

      <div aria-hidden="true" className="mt-3">
        <div className="relative mx-2 h-6">
          <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
          {cityMedian !== null ? (
            <div className="absolute top-0 h-6 w-0.5 -translate-x-1/2 bg-muted-foreground/70" style={{ left: pos(cityMedian) }} />
          ) : null}
          {overallRating !== null ? (
            <div
              className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-foreground"
              style={{ left: pos(overallRating) }}
            />
          ) : null}
          <div
            className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border-2 border-card bg-accent"
            style={{ left: pos(ayushman) }}
          />
        </div>
        <div className="mx-2 flex justify-between text-[11px] text-muted-foreground">
          <span>1★</span>
          <span>5★</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          {overallRating !== null ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-full bg-foreground" /> Overall
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rotate-45 bg-accent" /> Ayushman-mentioning
          </span>
          {cityMedian !== null ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-0.5 bg-muted-foreground/70" /> City median
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
