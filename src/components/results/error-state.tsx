"use client";

import Link from "next/link";
import { ArrowLeft, RefreshCw, TriangleAlert, Zap } from "lucide-react";
import type { CityId, StatusResponse, TreatmentId } from "@/types/domain";
import type { ClientError, ClientErrorCode } from "@/hooks/useCheckStream";
import { CITIES, TREATMENTS } from "@/config/presets";
import { Button } from "@/components/ui/button";
import { checkHref } from "./format";

interface ErrorCopy {
  title: string;
  body: string;
  retry: boolean;
  combos: boolean;
}

function copyFor(code: ClientErrorCode, cityName: string): ErrorCopy {
  switch (code) {
    case "INVALID_INPUT":
      return { title: "That search isn't supported", body: "Pick a city and a treatment from the lists.", retry: false, combos: true };
    case "NOT_AVAILABLE_OFFLINE":
      return {
        title: "Not pre-fetched yet",
        body: "Live search is turned off on this server, and this city and treatment haven't been saved as a snapshot. These are ready instantly:",
        retry: false,
        combos: true,
      };
    case "RATE_LIMITED":
      return {
        title: "Too many live checks from your network",
        body: "Live checks are limited per hour to protect a shared search budget. Try again later, or open one that's ready instantly:",
        retry: false,
        combos: true,
      };
    case "CREDIT_CAP":
      return {
        title: "Today's live search budget is used up",
        body: "Pre-fetched results still work and cost nothing:",
        retry: false,
        combos: true,
      };
    case "UPSTREAM":
      return {
        title: "Google data didn't come through",
        body: "SerpApi or Google didn't respond in time. Please try again in a minute.",
        retry: true,
        combos: true,
      };
    case "NO_RESULTS":
      return {
        title: "No hospitals found",
        body: `Google Maps returned no matching hospitals for this treatment near ${cityName}. Try “Any treatment” or another city.`,
        retry: false,
        combos: false,
      };
    case "NETWORK":
      return { title: "Can't reach Card Chalega", body: "Check your internet connection and try again.", retry: true, combos: false };
    case "INTERRUPTED":
      return {
        title: "The check stopped part-way",
        body: "The connection closed before all results arrived. Anything shown below is incomplete.",
        retry: true,
        combos: false,
      };
    case "INTERNAL":
      return { title: "Something went wrong", body: "Please try again.", retry: true, combos: false };
  }
}

interface ErrorStateProps {
  error: ClientError;
  city: CityId;
  treatment: TreatmentId;
  status: StatusResponse | null;
  onRetry: () => void;
}

export function ErrorState({ error, city, treatment, status, onRetry }: ErrorStateProps) {
  const copy = copyFor(error.code, CITIES[city].name);
  const combos = (status?.combos ?? []).filter((c) => !(c.city === city && c.treatment === treatment));

  return (
    <div role="alert" className="rounded-xl border border-warning-border bg-warning p-4 text-warning-foreground sm:p-5">
      <p className="flex items-center gap-2 font-semibold">
        <TriangleAlert className="size-5 shrink-0" aria-hidden="true" />
        {copy.title}
      </p>
      <p className="mt-1 text-sm">{copy.body}</p>
      {error.message && error.message !== copy.body ? (
        <p className="mt-1 text-xs opacity-80">Details: {error.message}</p>
      ) : null}

      {copy.combos && combos.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2">
          {combos.map((c) => (
            <li key={`${c.city}:${c.treatment}`}>
              <Button asChild variant="outline" size="sm">
                <Link href={checkHref(c.city, c.treatment)}>
                  <Zap aria-hidden="true" />
                  {CITIES[c.city].name} · {TREATMENTS[c.treatment].label}
                </Link>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {copy.retry ? (
          <Button size="sm" onClick={onRetry}>
            <RefreshCw aria-hidden="true" />
            Try again
          </Button>
        ) : null}
        <Button asChild variant="outline" size="sm">
          <Link href={`/?city=${city}&treatment=${treatment}#check`}>
            <ArrowLeft aria-hidden="true" />
            Change search
          </Link>
        </Button>
      </div>
    </div>
  );
}
