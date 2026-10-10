import Link from "next/link";
import { ArrowRight, Check, Minus, ScanSearch, ShieldCheck, Sparkles, MapPinned } from "lucide-react";
import { CITY_IDS, TREATMENT_IDS, type CityId, type HospitalScore, type TreatmentId } from "@/types/domain";
import { CheckForm } from "@/components/check/check-form";
import { EvidenceBar } from "@/components/results/evidence-bar";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pick<T extends string>(allowed: readonly T[], v: string | string[] | undefined): T | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return allowed.find((a) => a === s);
}

const STEPS = [
  {
    icon: MapPinned,
    title: "Find the hospitals",
    body: "SerpApi’s Google Maps engine lists hospitals for your treatment around the city centre. We keep the 8 with the most reviews.",
  },
  {
    icon: ScanSearch,
    title: "Pull the Ayushman reviews",
    body: "SerpApi’s Google Maps Reviews engine searches inside each hospital’s reviews for “ayushman” — only those reviews are read.",
  },
  {
    icon: Sparkles,
    title: "AI sorts each report, code counts",
    body: "Claude labels what happened in each review — cashless, charged, turned away — and cites the sentences. Code does all counting and comparison.",
  },
];

const COMPARISON: { row: string; google: string | null; us: string }[] = [
  { row: "Find reviews that mention Ayushman", google: "One hospital at a time", us: "Every hospital in one go" },
  { row: "Sort reports by what happened", google: null, us: "Cashless / charged / turned away" },
  { row: "Show how many reports (n)", google: null, us: "On every card" },
  { row: "Compare with the rest of the city", google: null, us: "City median rating" },
  { row: "Next steps if refused", google: null, us: "Helpline, complaint portal, call script" },
];

/** Illustration only — clearly labelled, never presented as data. */
const EXAMPLE_SCORE: HospitalScore = {
  dataId: "example",
  n: 9,
  counts: {
    CASHLESS_OK: 3,
    CHARGED_FOR_PACKAGE_ITEMS: 3,
    CHARGED_OUTSIDE_PACKAGE_OR_UNCLEAR: 1,
    REFUSED: 1,
    ELIGIBILITY_OR_SPECIALTY_DISPUTE: 0,
    DELAY: 1,
    NOT_PMJAY: 0,
    NAME_COLLISION: 0,
    MENTION_ONLY: 0,
  },
  problemCount: 4,
  cashlessOkCount: 3,
  ayushmanRating: 2.0,
  overallRating: 4.6,
  deltaVsCityMedian: -1.3,
  label: "more_problem_reports",
  treatmentMentions: { k: 0, n: 9 },
  latestReportIso: null,
  amountsInr: [],
};

export default async function Home({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const defaultCity: CityId | undefined = pick(CITY_IDS, params.city);
  const defaultTreatment: TreatmentId | undefined = pick(TREATMENT_IDS, params.treatment);

  return (
    <>
      {/* ---------- hero + form ---------- */}
      <section aria-labelledby="hero-heading" className="border-b border-border bg-gradient-to-b from-secondary/50 to-background">
        {/* Phones: headline → form → value prop, so the form sits near the fold. Desktop: text left, form right. */}
        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 sm:px-6 sm:py-14 lg:grid-cols-[1.1fr_1fr] lg:items-start lg:gap-x-12 lg:gap-y-4">
          <div className="flex flex-col gap-3 sm:gap-4 lg:col-start-1 lg:row-start-1">
            <p className="text-sm font-medium text-primary">For Ayushman Bharat (PM-JAY) cardholders</p>
            <h1
              id="hero-heading"
              className="text-[1.75rem] font-semibold leading-tight tracking-tight text-balance sm:text-4xl lg:text-5xl"
            >
              Will your Ayushman card work at this hospital?
            </h1>
            <p lang="hi" className="text-lg text-muted-foreground">
              आयुष्मान कार्ड चलेगा?
            </p>
            <p className="leading-relaxed sm:text-lg">
              The card should mean cashless treatment at empanelled hospitals — yet patients often report being asked to pay,
              or turned away at the desk.
            </p>
          </div>

          <p className="leading-relaxed text-muted-foreground max-lg:order-2 lg:col-start-1 lg:row-start-2">
            Google Maps lets you search one hospital&apos;s reviews. Card Chalega compares every hospital in your city — what
            Ayushman cardholders report: cashless, charged, or turned away.
          </p>

          <div
            id="check"
            className="scroll-mt-24 rounded-2xl border border-border bg-card p-5 shadow-md max-lg:order-1 sm:p-6 lg:col-start-2 lg:row-span-2 lg:row-start-1"
          >
            <h2 className="text-lg font-semibold">Check hospitals in your city</h2>
            <p className="mb-4 mt-1 text-sm text-muted-foreground">Free, no sign-up. Pick a city and a treatment.</p>
            <CheckForm defaultCity={defaultCity} defaultTreatment={defaultTreatment} />
          </div>
        </div>
      </section>

      {/* ---------- how it works ---------- */}
      <section aria-labelledby="how-heading" className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <h2 id="how-heading" className="text-2xl font-semibold tracking-tight">
          How it works
        </h2>
        <ol className="mt-6 grid gap-4 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-full bg-secondary text-sm font-semibold text-secondary-foreground">
                  {i + 1}
                </span>
                <s.icon className="size-5 text-primary" aria-hidden="true" />
              </div>
              <h3 className="font-semibold">{s.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{s.body}</p>
            </li>
          ))}
        </ol>

        <figure className="mt-8 rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="muted">Illustration — not a real hospital</Badge>
          </div>
          <p className="mt-3 text-sm leading-relaxed">
            Overall <strong>4.6★</strong> <span className="text-muted-foreground">(2,341)</span> · Ayushman-mentioning reviews{" "}
            <strong>2.0★</strong> <span className="text-muted-foreground">(n=9)</span> · city median 3.3★
          </p>
          <p className="mt-1 text-sm font-medium">1.3★ below city median</p>
          <EvidenceBar score={EXAMPLE_SCORE} className="mt-4" />
          <figcaption className="mt-4 text-sm text-muted-foreground">
            What a result card shows: the hospital&apos;s overall rating next to the rating in reviews that mention the card,
            the city median, and how many reviewers reported each outcome.
          </figcaption>
        </figure>
      </section>

      {/* ---------- trust & limits ---------- */}
      <section aria-labelledby="trust-heading" className="border-y border-border bg-muted/40">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
          <h2 id="trust-heading" className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <ShieldCheck className="size-6 text-primary" aria-hidden="true" />
            What you can trust — and what you can&apos;t
          </h2>
          <ul className="mt-6 grid gap-4 sm:grid-cols-2">
            {[
              ["Reviews are self-reported.", "They are experiences people chose to post, not audited records."],
              ["n is always shown.", "Labels appear only with at least 3 reports; the rating split needs 5."],
              ["No verdicts.", "We never call a hospital safe or unsafe — we show what reviewers report."],
              ["Quotes are verbatim and linked.", "Every quote links to the original review on Google Maps; hospital replies are shown."],
            ].map(([title, body]) => (
              <li key={title} className="rounded-xl border border-border bg-card p-5">
                <p className="font-semibold">{title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ---------- why not just Google ---------- */}
      <section aria-labelledby="why-heading" className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <h2 id="why-heading" className="text-2xl font-semibold tracking-tight">
          Why not just Google?
        </h2>
        <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <table className="w-full table-fixed text-left text-sm">
            <caption className="sr-only">Searching Google Maps yourself compared with Card Chalega</caption>
            <thead className="bg-muted/60">
              <tr>
                <th scope="col" className="w-[40%] px-3 py-3 font-semibold sm:px-4">
                  Task
                </th>
                <th scope="col" className="px-3 py-3 font-semibold sm:px-4">
                  Google Maps
                </th>
                <th scope="col" className="px-3 py-3 font-semibold sm:px-4">
                  Card Chalega
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {COMPARISON.map((r) => (
                <tr key={r.row}>
                  <th scope="row" className="px-3 py-3 align-top font-medium sm:px-4">
                    {r.row}
                  </th>
                  <td className="px-3 py-3 align-top text-muted-foreground sm:px-4">
                    {r.google ?? (
                      <span className="inline-flex items-center gap-1">
                        <Minus className="size-4 shrink-0" aria-hidden="true" />
                        Not available
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 align-top sm:px-4">
                    <span className="inline-flex items-start gap-1">
                      <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                      {r.us}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-6">
          <Link href="/methodology" className={buttonVariants({ variant: "outline" })}>
            Read the methodology
            <ArrowRight aria-hidden="true" />
          </Link>
        </p>
      </section>
    </>
  );
}
