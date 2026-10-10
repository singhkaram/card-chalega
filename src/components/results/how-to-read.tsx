"use client";

import Link from "next/link";
import { Info } from "lucide-react";
import { EVIDENCE_CLASSES } from "@/types/domain";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { MIN_N_FOR_LABEL, MIN_N_FOR_RATING, WINDOW_MONTHS } from "@/lib/scoring/score";
import { CLASS_INFO, LABEL_TEXT } from "./evidence";

/** Plain-language guide to a result card, opened from the results header. */
export function HowToRead() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Info aria-hidden="true" />
          How to read this
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>How to read a hospital card</DialogTitle>
          <DialogDescription>
            Every number comes from Google Maps reviews that mention “ayushman”, fetched through SerpApi.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 text-sm">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              <strong>n</strong> is the number of reviews from the last {WINDOW_MONTHS} months that are about using the
              PM-JAY card at that hospital. Older reviews are shown but not counted.
            </li>
            <li>
              A summary label (“{LABEL_TEXT.more_problem_reports}”, “{LABEL_TEXT.more_cashless_reports}” or
              “{LABEL_TEXT.mixed_reports}”) appears only when n is at least {MIN_N_FOR_LABEL}. It compares problem and
              cashless reports at that one hospital — it is not a verdict on the hospital.
            </li>
            <li>
              The <strong>rating split</strong> compares the hospital&apos;s overall Google rating with the average rating of
              its Ayushman-mentioning reviews, shown only when n is at least {MIN_N_FOR_RATING}. The city median is the
              middle value across hospitals that have one.
            </li>
            <li>
              Quotes are the reviewer&apos;s own words, or Google&apos;s translation where marked, and link to the original
              review. Hospital replies are shown with them where they exist.
            </li>
            <li>
              <strong>Rule-based (AI unavailable)</strong> means the AI classifier could not run, so a cautious keyword
              fallback sorted that hospital&apos;s reviews.
            </li>
            <li>
              <strong>Name contains “Ayushman” — filtered</strong> marks a hospital whose own name contains the word; its
              reviews count only when they clearly refer to the PM-JAY card or scheme.
            </li>
          </ul>
          <div>
            <h3 className="font-semibold">What each report type means</h3>
            <dl className="mt-2 flex flex-col gap-2">
              {EVIDENCE_CLASSES.map((cls) => (
                <div key={cls}>
                  <dt className="flex items-center gap-2.5 font-medium">
                    <span className={cn("ev-swatch size-3.5 shrink-0 rounded-[3px]", CLASS_INFO[cls].swatch)} aria-hidden="true" />
                    {CLASS_INFO[cls].label}
                  </dt>
                  <dd className="pl-6 text-muted-foreground">{CLASS_INFO[cls].description}</dd>
                </div>
              ))}
            </dl>
          </div>
          <p>
            <Link href="/methodology" className="font-medium text-primary underline underline-offset-4">
              Read the full methodology
            </Link>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
