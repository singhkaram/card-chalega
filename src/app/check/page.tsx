import type { Metadata } from "next";
import Link from "next/link";
import { SearchX } from "lucide-react";
import { CITY_IDS, type CityId, type TreatmentId } from "@/types/domain";
import { isCityId, isTreatmentId } from "@/lib/utils";
import { CITIES, TREATMENTS } from "@/config/presets";
import { buttonVariants } from "@/components/ui/button";
import { ResultsView } from "@/components/results/results-view";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function parse(params: Record<string, string | string[] | undefined>): { city: CityId; treatment: TreatmentId } | null {
  const city = first(params.city)?.toLowerCase();
  const treatment = first(params.treatment)?.toLowerCase() ?? "general";
  return isCityId(city) && isTreatmentId(treatment) ? { city, treatment } : null;
}

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const parsed = parse(await searchParams);
  if (!parsed) return { title: "Check a hospital", robots: { index: false } };
  return {
    title: `${CITIES[parsed.city].name} · ${TREATMENTS[parsed.treatment].label}`,
    description: `What Ayushman cardholders report about hospitals in ${CITIES[parsed.city].name}: cashless, asked to pay, or turned away.`,
  };
}

export default async function CheckPage({ searchParams }: { searchParams: SearchParams }) {
  const parsed = parse(await searchParams);

  if (!parsed) {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-4 px-4 py-16 text-center sm:py-24">
        <SearchX className="size-10 text-muted-foreground" aria-hidden="true" />
        <h1 className="text-2xl font-semibold tracking-tight">We can&apos;t check that yet</h1>
        <p className="text-muted-foreground">
          Card Chalega covers {CITY_IDS.map((c) => CITIES[c].name).join(", ")} and a fixed list of treatments. Pick a city
          and a treatment to start.
        </p>
        <Link href="/#check" className={buttonVariants({ size: "lg" })}>
          Choose a city and treatment
        </Link>
      </div>
    );
  }

  // Keyed so switching combos starts a fresh run with fresh UI state.
  return <ResultsView key={`${parsed.city}:${parsed.treatment}`} city={parsed.city} treatment={parsed.treatment} />;
}
