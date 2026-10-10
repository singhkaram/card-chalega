import { Database, Radio, TriangleAlert } from "lucide-react";
import type { DataSource } from "@/types/domain";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatIst } from "./format";

/** Where the data on screen came from — always visible, never implies live when it isn't. */
export function SourceBadge({
  source,
  fetchedAt,
  waiting,
}: {
  source: DataSource | null;
  fetchedAt: string | null;
  waiting: boolean;
}) {
  if (!source) return waiting ? <Skeleton className="h-6 w-44 rounded-full" /> : null;
  const when = formatIst(fetchedAt);
  switch (source) {
    case "live":
      return (
        <Badge variant="secondary">
          <Radio aria-hidden="true" />
          Live
        </Badge>
      );
    case "cache":
      return (
        <Badge variant="outline">
          <Database aria-hidden="true" />
          Cached{when ? ` · fetched ${when}` : ""}
        </Badge>
      );
    case "snapshot":
      return (
        <Badge variant="outline">
          <Database aria-hidden="true" />
          Snapshot{when ? ` fetched ${when}` : ""}
        </Badge>
      );
    case "sample":
      return (
        <Badge variant="warning" className="font-semibold">
          <TriangleAlert aria-hidden="true" />
          SAMPLE DATA — not real
        </Badge>
      );
  }
}

export function SampleBanner() {
  return (
    <div
      role="note"
      className="mb-6 flex gap-3 rounded-xl border-2 border-warning-border bg-warning p-4 text-warning-foreground sm:p-5"
    >
      <TriangleAlert className="mt-0.5 size-6 shrink-0" aria-hidden="true" />
      <div>
        <p className="text-lg font-bold tracking-tight">SAMPLE DATA — not real</p>
        <p className="mt-1 text-sm">
          These hospitals, reviews and numbers are synthetic, for development only. Do not use them to choose a hospital.
        </p>
      </div>
    </div>
  );
}
