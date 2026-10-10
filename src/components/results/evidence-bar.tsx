import type { EvidenceClass, HospitalScore } from "@/types/domain";
import { cn } from "@/lib/utils";
import { CLASS_INFO, describeGroups, groupCounts } from "./evidence";

/**
 * Single stacked bar of report counts by class group. Neutral hues plus a
 * distinct pattern per group; the visible legend carries labels and counts,
 * so colour is never the only signal.
 */
export function EvidenceBar({ score, className }: { score: HospitalScore; className?: string }) {
  const groups = groupCounts(score);
  const total = groups.reduce((sum, g) => sum + g.count, 0);
  if (total === 0) return null;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div
        role="img"
        aria-label={describeGroups(groups, score.n)}
        className="flex h-4 w-full gap-[2px] overflow-hidden rounded-full bg-muted"
      >
        {groups
          .filter((g) => g.count > 0)
          .map((g) => (
            <div
              key={g.id}
              className={cn("ev-swatch h-full", g.swatch)}
              style={{ flexGrow: g.count, flexBasis: 0, minWidth: "6px" }}
            />
          ))}
      </div>
      <ul className="grid grid-cols-1 gap-x-5 gap-y-1.5 text-sm min-[420px]:grid-cols-2">
        {groups.map((g) => (
          <li key={g.id} className={cn("flex items-center gap-2", g.count === 0 && "text-muted-foreground")}>
            <span className={cn("ev-swatch size-3.5 shrink-0 rounded-[3px]", g.swatch)} aria-hidden="true" />
            <span className="min-w-0 flex-1">{g.label}</span>
            <span className="font-semibold tabular-nums">{g.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Small chip naming one evidence class, with its pattern swatch. */
export function ClassChip({ cls, className }: { cls: EvidenceClass; className?: string }) {
  const info = CLASS_INFO[cls];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-xs font-medium",
        className,
      )}
    >
      <span className={cn("ev-swatch size-2.5 shrink-0 rounded-[2px]", info.swatch)} aria-hidden="true" />
      {info.label}
    </span>
  );
}
