// Card ordering for the results page. The rules live in lib/scoring
// (sortForDisplay); this adds the UI labels and a deterministic input order.

import type { Hospital, HospitalResult } from "@/types/domain";
import { sortForDisplay, type SortMode } from "@/lib/scoring/score";

export type { SortMode } from "@/lib/scoring/score";

export const SORT_OPTIONS: { key: SortMode; label: string }[] = [
  { key: "evidence", label: "Most evidence" },
  { key: "problems", label: "Highest share of problem reports" },
  { key: "cashless", label: "Highest share of cashless reports" },
];

/**
 * Results arrive in completion order, which varies run to run. Seeding the
 * stable sort with the hospital list order (Maps / snapshot order) makes ties
 * render the same way every time.
 */
export function orderResults(results: Iterable<HospitalResult>, hospitals: readonly Hospital[], mode: SortMode): HospitalResult[] {
  const position = new Map(hospitals.map((h, i) => [h.dataId, i]));
  const at = (r: HospitalResult) => position.get(r.hospital.dataId) ?? hospitals.length;
  const seeded = [...results].sort((a, b) => at(a) - at(b));
  return sortForDisplay(seeded, mode);
}
