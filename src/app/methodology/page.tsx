import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { CITY_IDS, EVIDENCE_CLASSES, PROBLEM_CLASSES, TREATMENT_IDS } from "@/types/domain";
import { CITIES, HOSPITALS_PER_RUN, TREATMENTS } from "@/config/presets";
import { CLASS_INFO, LABEL_TEXT } from "@/components/results/evidence";
import { MIN_N_FOR_LABEL, MIN_N_FOR_RATING, WINDOW_MONTHS } from "@/lib/scoring/score";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Methodology",
  description:
    "Exactly how Card Chalega? turns SerpApi Google Maps reviews into counts: data sources, the 9 evidence classes, scoring rules, grounding, limitations, privacy and AI disclosure.",
};

const SECTIONS = [
  { id: "sources", title: "Data sources" },
  { id: "classes", title: "The 9 evidence classes" },
  { id: "scoring", title: "Scoring rules" },
  { id: "grounding", title: "How the AI is kept honest" },
  { id: "limits", title: "Limitations and biases" },
  { id: "privacy", title: "Privacy" },
  { id: "fairness", title: "Fairness to hospitals" },
  { id: "ai", title: "AI disclosure" },
];

const CREDITS_PER_RUN = 1 + HOSPITALS_PER_RUN + 2;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-24 border-t border-border pt-8">
      <h2 id={`${id}-h`} className="text-2xl font-semibold tracking-tight">
        {title}
      </h2>
      <div className="mt-4 flex flex-col gap-4 leading-relaxed">{children}</div>
    </section>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.9em] break-words">{children}</code>;
}

function Table({ caption, head, rows }: { caption: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full min-w-[32rem] text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-muted/60">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="px-3 py-2.5 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((cells, i) => (
            <tr key={i}>
              {cells.map((c, j) =>
                j === 0 ? (
                  <th key={j} scope="row" className="px-3 py-2.5 align-top font-medium">
                    {c}
                  </th>
                ) : (
                  <td key={j} className="px-3 py-2.5 align-top">
                    {c}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function MethodologyPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <div className="max-w-3xl">
        <p className="text-sm font-medium text-primary">Methodology</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">How the numbers are made</h1>
        <p className="mt-4 text-lg text-muted-foreground">
          Every number on Card Chalega traces back to a SerpApi response. An AI model labels each review; ordinary code does
          all the counting, comparing and quoting. This page explains each step, and what the numbers cannot tell you.
        </p>
      </div>

      <div className="mt-10 grid gap-10 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav aria-label="On this page" className="lg:sticky lg:top-24 lg:self-start">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">On this page</p>
          <ol className="mt-2 flex flex-col gap-1 text-sm">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="inline-flex min-h-8 items-center text-muted-foreground hover:text-foreground">
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="flex min-w-0 max-w-3xl flex-col gap-10">
          <Section id="sources" title="Data sources">
            <p>
              Card Chalega uses three SerpApi engines. Inputs come only from fixed lists (5 cities, 6 treatments), so no free
              text is ever sent to SerpApi or to the AI model.
            </p>
            <Table
              caption="SerpApi engines and parameters used per run"
              head={["Engine", "Parameters", "Searches per run"]}
              rows={[
                [
                  <Code key="e">google_maps</Code>,
                  <span key="p">
                    <Code>type=search</Code>, <Code>q</Code> (the treatment query below), <Code>ll=@lat,lng,13z</Code> (fixed city
                    centre), <Code>hl=en</Code>
                  </span>,
                  "1",
                ],
                [
                  <Code key="e">google_maps_reviews</Code>,
                  <span key="p">
                    <Code>data_id</Code> (the hospital), <Code>query=ayushman</Code> (search inside the reviews),{" "}
                    <Code>sort_by=newestFirst</Code>, <Code>num=20</Code> (the most one request returns),{" "}
                    <Code>hl=en</Code>. Each hospital&apos;s 20 newest matching reviews are used.
                  </span>,
                  `${HOSPITALS_PER_RUN} (one per hospital)`,
                ],
                [
                  <Code key="e">google_news</Code>,
                  <span key="p">
                    <Code>q=&quot;Ayushman card hospital City&quot;</Code> with <Code>hl=en</Code>, and the Hindi query{" "}
                    <span lang="hi"><Code>आयुष्मान कार्ड अस्पताल शहर</Code></span> with <Code>hl=hi</Code>; both <Code>gl=in</Code>
                  </span>,
                  "2",
                ],
              ]}
            />
            <p>
              A fresh (cold) run therefore costs about <strong>{CREDITS_PER_RUN} searches</strong>. Refreshing a single
              hospital costs 1. Runs served from a snapshot or cache cost 0, and the footer of every results page says which
              it was and how many searches it used.
            </p>
            <h3 className="text-lg font-semibold">Which hospitals are compared</h3>
            <p>
              From the Google Maps results, we keep listings whose Google category matches the treatment (for example
              hospital, nursing home, or an eye hospital for cataract), drop pharmacies, labs and clinics that don&apos;t
              admit patients, and compare the {HOSPITALS_PER_RUN} with the most reviews. News headlines are shown for
              context and never affect any count.
            </p>
            <Table
              caption="Google Maps query used for each treatment"
              head={["Treatment", "Google Maps query (q)"]}
              rows={TREATMENT_IDS.map((t) => [TREATMENTS[t].label, <Code key="q">{TREATMENTS[t].mapsQuery}</Code>])}
            />
            <Table
              caption="Fixed city centres"
              head={["City", "Map centre (ll)"]}
              rows={CITY_IDS.map((c) => [
                `${CITIES[c].name}, ${CITIES[c].state}`,
                <Code key="ll">{`@${CITIES[c].lat},${CITIES[c].lng},${CITIES[c].zoom}z`}</Code>,
              ])}
            />
            <h3 className="text-lg font-semibold">Snapshots, caching and timestamps</h3>
            <p>
              Each request is answered from, in order: a short-lived memory cache, a saved snapshot, or a live SerpApi call.
              Live calls happen only when the server allows them and a daily search budget has room. Snapshots are real
              SerpApi responses saved with the time they were fetched, and the page always shows that time in IST — a
              snapshot is never presented as live. A separate synthetic “sample” mode exists for development only; it is
              refused in production and always carries a large “SAMPLE DATA — not real” banner.
            </p>
          </Section>

          <Section id="classes" title="The 9 evidence classes">
            <p>
              Each review that mentions Ayushman gets exactly one class. Two classes are about something other than using
              the card at this hospital, so they are shown but not counted.
            </p>
            <Table
              caption="Evidence classes and how they are counted"
              head={["Class", "Meaning", "Counted in n", "Problem report"]}
              rows={EVIDENCE_CLASSES.map((cls) => [
                <span key="l" className="inline-flex items-center gap-2">
                  <span className={cn("ev-swatch size-3.5 shrink-0 rounded-[3px]", CLASS_INFO[cls].swatch)} aria-hidden="true" />
                  {CLASS_INFO[cls].label}
                </span>,
                CLASS_INFO[cls].description,
                CLASS_INFO[cls].counted ? "Yes" : "No",
                PROBLEM_CLASSES.includes(cls) ? "Yes" : cls === "CASHLESS_OK" ? "No (cashless report)" : "No",
              ])}
            />
          </Section>

          <Section id="scoring" title="Scoring rules">
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong>Window.</strong> Only reviews from the last {WINDOW_MONTHS} months count. Older ones are shown,
                marked “older”, and left out of every number.
              </li>
              <li>
                <strong>n</strong> is the number of counted reviews in the window (everything except “Not about PM-JAY” and
                “Hospital name only”).
              </li>
              <li>
                <strong>Problem reports</strong> = “Asked to pay for package items” + “Turned away”.{" "}
                <strong>Cashless reports</strong> = “Cashless OK”. Disputes, delays and unclear charges are shown but are not
                counted as problems.
              </li>
              <li>
                <strong>Labels</strong> need n ≥ {MIN_N_FOR_LABEL} and compare reports at that one hospital, never with
                other hospitals. “{LABEL_TEXT.more_problem_reports}” when problems ≥ 2 and problems &gt; 1.5 × cashless;
                “{LABEL_TEXT.more_cashless_reports}” when cashless ≥ 2 and cashless &gt; 1.5 × problems; otherwise
                “{LABEL_TEXT.mixed_reports}”. Below {MIN_N_FOR_LABEL}, the card says “Too few reports” and suggests
                calling ahead. A label describes what reviewers posted; it is not a verdict on the hospital.
              </li>
              <li>
                <strong>Rating split.</strong> The average star rating of the counted Ayushman-mentioning reviews, shown next
                to the hospital&apos;s overall Google rating — only when n ≥ {MIN_N_FOR_RATING}.
              </li>
              <li>
                <strong>City baseline.</strong> The median rating split across the compared hospitals that have one. Each
                hospital&apos;s difference from it is stated in words (“1.3★ below city median”).
              </li>
              <li>
                <strong>Treatment-specific.</strong> For a chosen treatment, “k of n” counts the reports in which that
                treatment is mentioned.
              </li>
            </ul>
          </Section>

          <Section id="grounding" title="How the AI is kept honest">
            <ul className="list-disc space-y-2 pl-5">
              <li>
                Each review is split into numbered sentences. The model (Claude) returns a class and the ids of the sentences
                it relied on, in a fixed JSON format.
              </li>
              <li>
                Code checks every sentence id and builds the quote itself from those sentences, word for word. The model
                never writes a quote.
              </li>
              <li>A rupee amount is kept only if its digits actually appear in the cited sentences.</li>
              <li>
                Review text is passed to the model as data, not instructions, and the output must match the schema — a review
                cannot change how others are scored.
              </li>
              <li>
                If the model is unavailable, a keyword-based fallback runs instead, and each card says “Rule-based (AI
                unavailable)”.
              </li>
            </ul>
          </Section>

          <Section id="limits" title="Limitations and biases">
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong>Self-selection.</strong> People are more likely to write a review after a very bad or very good
                experience. Counts describe what reviewers posted, not what typically happens.
              </li>
              <li>
                <strong>Keyword filter misses.</strong> Only reviews Google matches to “ayushman” are read. Reviews that say
                only “golden card”, “PMJAY” or “yojana”, or use unusual spellings, may be missed.
              </li>
              <li>
                <strong>Review depth.</strong> For each hospital we read one page of the reviews Google matches to
                “ayushman”: at most 20, newest first. Busy hospitals may have more matching reviews than we read, so n
                describes that sample, and the {WINDOW_MONTHS}-month window is applied to it. Cards say when more exist.
              </li>
              <li>
                <strong>Google translation.</strong> Some reviews are shown with Google&apos;s translation. We show the
                original words, with the translation underneath. When only the translated sentences were cited, the card
                shows Google&apos;s translation, labelled as such, and links to the original. Translation errors can affect
                labels.
              </li>
              <li>
                <strong>Review manipulation.</strong> Fake or solicited reviews exist on any platform, in both directions.
              </li>
              <li>
                <strong>Specialty-specific empanelment.</strong> A hospital may accept the card only for some specialties. A
                refusal can reflect that — check the PM-JAY hospital finder for your treatment.
              </li>
              <li>
                <strong>Coverage.</strong> Only the {HOSPITALS_PER_RUN} most-reviewed matching hospitals near the city centre
                are compared; smaller hospitals and some government hospitals may not appear.
              </li>
              <li>
                <strong>Time.</strong> Reviews describe the past. Policies, staff and empanelment change.
              </li>
            </ul>
          </Section>

          <Section id="privacy" title="Privacy">
            <ul className="list-disc space-y-2 pl-5">
              <li>
                Reviewer names, profile links and photos are removed before anything is saved, and are never shown. Hospital
                replies often greet the reviewer by name, so that opening greeting is removed too. Quotes link to the public
                review on Google Maps.
              </li>
              <li>There are no accounts. Your searches are not linked to you.</li>
              <li>A short-lived per-network counter limits live searches to protect a shared search budget.</li>
            </ul>
          </Section>

          <Section id="fairness" title="Fairness to hospitals">
            <ul className="list-disc space-y-2 pl-5">
              <li>
                Hospital replies to reviews are shown next to the quotes they answer, in their original language with
                Google&apos;s translation where one exists.
              </li>
              <li>
                No verdicts: we never call a hospital safe, unsafe or a scam. Colours are neutral, never red or green, and
                every bar has labels and counts.
              </li>
              <li>n is always shown; labels and rating splits are withheld when there are too few reports.</li>
              <li>
                Hospitals whose own name contains “Ayushman” are handled separately: a review counts only if it is clearly
                about the card or scheme.
              </li>
              <li>Cashless reports are always surfaced alongside problem reports when both exist.</li>
            </ul>
          </Section>

          <Section id="ai" title="AI disclosure">
            <p>
              Reviews are classified by Claude, a model made by Anthropic. Counting, scoring, ordering and quoting are done by
              ordinary code. The app itself was built with the help of AI tools (Claude Code).
            </p>
            <p className="font-medium">
              Card Chalega is not affiliated with the National Health Authority or PM-JAY, and is not medical or legal advice.
              For official help, call 14555.
            </p>
            <p>
              <Link href="/#check" className="font-medium text-primary underline underline-offset-4">
                Start a check
              </Link>
            </p>
          </Section>
        </div>
      </div>
    </div>
  );
}
