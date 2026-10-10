import { Scale } from "lucide-react";
import type { CityBaseline } from "@/types/domain";
import { Skeleton } from "@/components/ui/skeleton";
import { MIN_N_FOR_RATING, WINDOW_MONTHS } from "@/lib/scoring/score";
import { formatStars, plural } from "./format";

interface BaselineStripProps {
  baseline: CityBaseline | null;
  cityName: string;
  waiting: boolean;
}

/** City median of the Ayushman-mentioning rating — the reference every card is compared with. */
export function BaselineStrip({ baseline, cityName, waiting }: BaselineStripProps) {
  if (!baseline) {
    // Reserve the line while the run is in flight so cards don't jump when it lands.
    return waiting ? <Skeleton className="h-11 w-full rounded-lg" /> : null;
  }
  const { medianAyushmanRating: median, hospitalsWithRating: k } = baseline;
  return (
    <p className="flex items-start gap-2 rounded-lg border border-border bg-secondary/60 px-3 py-2.5 text-sm text-secondary-foreground">
      <Scale className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {median !== null ? (
        <span>
          {cityName} median for Ayushman-mentioning reviews: <strong className="font-semibold">{formatStars(median)}</strong> across{" "}
          {k} {plural(k, "hospital", "hospitals")} with ≥{MIN_N_FOR_RATING} reports.
        </span>
      ) : (
        <span>
          No city median yet — it needs hospitals with at least {MIN_N_FOR_RATING} Ayushman reports in the last {WINDOW_MONTHS} months
          ({baseline.hospitalsConsidered} checked).
        </span>
      )}
    </p>
  );
}
