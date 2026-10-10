"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, LoaderCircle, Zap } from "lucide-react";
import { CITIES, TREATMENTS } from "@/config/presets";
import { CITY_IDS, TREATMENT_IDS, type CityId, type TreatmentId } from "@/types/domain";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { checkHref, formatIst } from "@/components/results/format";
import { isInstant, useStatus } from "./use-status";
import { cn, isCityId, isTreatmentId } from "@/lib/utils";

function InstantBadge({ className }: { className?: string }) {
  return (
    <Badge variant="secondary" className={cn("px-2 py-0 text-[11px]", className)}>
      <Zap aria-hidden="true" />
      Instant
    </Badge>
  );
}

interface CheckFormProps {
  defaultCity?: CityId;
  defaultTreatment?: TreatmentId;
  className?: string;
}

export function CheckForm({ defaultCity = "lucknow", defaultTreatment = "general", className }: CheckFormProps) {
  const router = useRouter();
  const id = useId();
  const [city, setCity] = useState<CityId>(defaultCity);
  const [treatment, setTreatment] = useState<TreatmentId>(defaultTreatment);
  const [pending, startTransition] = useTransition();
  const { status, loading } = useStatus();

  const instant = isInstant(status, city, treatment);
  const combo = status?.combos.find((c) => c.city === city && c.treatment === treatment);
  const cityHasInstant = (c: CityId) => Boolean(status?.combos.some((x) => x.city === c));

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startTransition(() => router.push(checkHref(city, treatment)));
  }

  const cityInfo = CITIES[city];
  const treatmentInfo = TREATMENTS[treatment];
  const noteId = `${id}-note`;

  return (
    <form onSubmit={onSubmit} className={cn("@container flex flex-col gap-5", className)}>
      {/* Side by side only when the form itself is wide enough (it sits in a narrow card on desktop). */}
      <div className="grid gap-4 @lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={`${id}-city`} className="text-sm font-medium">
            City <span lang="hi" className="font-normal text-muted-foreground">· शहर</span>
          </label>
          <Select value={city} onValueChange={(v) => isCityId(v) && setCity(v)} disabled={pending}>
            <SelectTrigger id={`${id}-city`}>
              <SelectValue>
                {cityInfo.name}{" "}
                <span lang="hi" className="text-muted-foreground">
                  · {cityInfo.nameHi}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {CITY_IDS.map((c) => (
                <SelectItem
                  key={c}
                  value={c}
                  text={CITIES[c].name}
                  hint={
                    <>
                      <span lang="hi" className="text-muted-foreground">
                        {CITIES[c].nameHi}
                      </span>
                      {cityHasInstant(c) ? <InstantBadge /> : null}
                    </>
                  }
                />
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={`${id}-treatment`} className="text-sm font-medium">
            Treatment <span lang="hi" className="font-normal text-muted-foreground">· इलाज</span>
          </label>
          <Select value={treatment} onValueChange={(v) => isTreatmentId(v) && setTreatment(v)} disabled={pending}>
            <SelectTrigger id={`${id}-treatment`}>
              <SelectValue>
                {treatmentInfo.label}{" "}
                <span lang="hi" className="text-muted-foreground">
                  · {treatmentInfo.labelHi}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {TREATMENT_IDS.map((t) => (
                <SelectItem
                  key={t}
                  value={t}
                  text={TREATMENTS[t].label}
                  hint={
                    <>
                      <span lang="hi" className="hidden text-muted-foreground sm:inline">
                        {TREATMENTS[t].labelHi}
                      </span>
                      {isInstant(status, city, t) ? <InstantBadge /> : null}
                    </>
                  }
                />
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <p id={noteId} aria-live="polite" className="min-h-10 text-sm text-muted-foreground">
        {loading ? (
          "Checking which searches are ready instantly…"
        ) : status?.dataMode === "sample" ? (
          <>
            <span className="font-medium text-warning-foreground">Sample data mode (development):</span>{" "}
            {instant ? "synthetic results, not real hospitals." : "only the sample combinations below are available."}
          </>
        ) : instant ? (
          <>
            <span className="font-medium text-foreground">
              <Zap className="mr-1 inline size-4 align-[-3px] text-primary" aria-hidden="true" />
              Instant:
            </span>{" "}
            real SerpApi results saved {combo?.fetchedAt ? `on ${formatIst(combo.fetchedAt)}` : "earlier"} — uses 0 new
            searches.
          </>
        ) : status?.liveEnabled ? (
          <>
            <span className="font-medium text-foreground">Live search:</span> takes about 20–40 seconds and uses about 11
            SerpApi searches.
          </>
        ) : status ? (
          <>
            <span className="font-medium text-foreground">Not pre-fetched yet.</span> Live search is off on this server — pick a
            combination marked <span className="whitespace-nowrap">“Instant”</span>.
          </>
        ) : (
          "Results come from Google Maps reviews via SerpApi."
        )}
      </p>

      <Button type="submit" size="lg" disabled={pending} aria-describedby={noteId} className="w-full sm:w-auto sm:self-start">
        {pending ? (
          <>
            <LoaderCircle className="animate-spin" aria-hidden="true" />
            Opening results…
          </>
        ) : (
          <>
            Check hospitals
            <ArrowRight aria-hidden="true" />
          </>
        )}
      </Button>

      {status && status.combos.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {status.dataMode === "sample" ? "Sample combinations" : "Ready instantly"}
          </p>
          <ul className="flex flex-wrap gap-2">
            {status.combos.slice(0, 8).map((c) => (
              <li key={`${c.city}:${c.treatment}`}>
                <Link
                  href={checkHref(c.city, c.treatment)}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <Zap className="size-3.5 text-primary" aria-hidden="true" />
                  {CITIES[c.city].name} · {TREATMENTS[c.treatment].label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </form>
  );
}
