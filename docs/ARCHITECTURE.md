# Card Chalega? — Product & Architecture (Phases 4–5)

## Product in one line

For a city and a treatment, compare every relevant hospital on what **Ayushman (PM-JAY) cardholders actually report** in Google Maps reviews — cashless honoured, asked to pay, or turned away — with counts, sample sizes, a city baseline and dated quotes.

## The 30-second demo

1. Landing: *"Maps can search one hospital's reviews. Card Chalega compares every hospital in your city."* Pick **city** and **treatment** and press **Check**.
2. A progress stepper shows the steps: Maps → Reviews (8 hospitals) → AI classify → Scores.
3. Hospital cards appear one by one, each with neutral evidence bars and the sample size *n*.
4. Open a highly rated hospital: **"Overall 4.6★ (2,341) · Ayushman-mentioning reviews 2.0★ (n=9) · city median 3.3★"**. Below are Hindi quotes with translations, approximate dates, the hospital's reply, and a link to each review.
5. The rights panel gives 14555, the CGRMS complaints portal, the PM-JAY hospital finder and a call-ahead script.
6. The footer reads *"snapshot fetched 05 Oct 2026, 14:10 IST · 0 searches"*. On stage, a 1-credit **Refresh this hospital** proves the data is live.

## Principles (non-negotiable)

- **SerpApi is the evidence.** Every number traces to a SerpApi response. Removing SerpApi removes the product.
- **AI classifies; code decides.** The LLM assigns one of 9 classes and cites sentence ids. Code assembles quotes, validates amounts, computes scores, labels and ordering. If the LLM is unavailable, a visible rules-based fallback runs instead.
- **Neutral and honest.** No red/green verdicts and no "safe" or "scam". *n* is always shown, labels need n ≥ 3 and the rating split needs n ≥ 5. Hospital replies are shown. Reviewer identities are never stored or shown.
- **Credits are scarce.** Snapshots come first, live calls are opt-in (`LIVE_SEARCH=on`), and a daily cap, a per-IP limit and the Account API floor all apply. A cold run costs about 11 searches; a snapshot or cached run costs 0.
- **Never fake live.** Snapshots are real SerpApi responses labelled with their fetch time. Sample data (`DATA_SOURCE=sample`) is synthetic, dev-only, refused in production and always bannered.

## Data flow

```
Browser (client)                         Server (Next.js route handlers, Node runtime)
────────────────                         ──────────────────────────────────────────────
CheckForm ──POST /api/check {city,treatment}──▶ zod validation → guards (rate limit, mode)
                                               │
useCheckStream ◀── NDJSON CheckEvent stream ───┤ pipeline.runCheck
                                               │  1. google_maps (q=treatment.mapsQuery, ll=@city)   [1 credit]
                                               │     → normalizeMapsResults → top 8 by review count
                                               │  2. google_maps_reviews (data_id, query="ayushman", sort_by=newestFirst,
                                               │     num from the gate) ×8 in parallel                [8]
                                               │     → normalizeReviews (no reviewer identity)
                                               │  3. classify per hospital: pre-rules → memory → committed
                                               │     data/classifications → Claude (structured output) → rules fallback
                                               │     → sentence-id grounding, quotes built by code
                                               │  4. scoreHospital → emit "hospital" events as each completes
                                               │  5. computeBaseline (city median) → emit "baseline"
                                               │  6. google_news en + hi (city context banner)        [2]
                                               └─ emit "done" {creditsUsed, source, oldestFetchedAt}
```

The store is consulted in this order for every SerpApi request: **memory (TTL) → snapshot files (`data/snapshots`) → live SerpApi**. Live is used only if it's allowed and within budget.

## Modules (strict TypeScript, `src/`)

| Path | Responsibility | Server-only |
|---|---|---|
| `types/domain.ts` | Shared contracts (Hospital, Review, ClassifiedMention, HospitalScore, CheckEvent…) | – |
| `config/presets.ts` | Allowlisted cities (hard-coded coordinates), treatments, scheme terms, rights links | – |
| `lib/serpapi/client.ts` | HTTP client: key from env, timeout, error mapping, key redaction, Account API | ✓ (via index) |
| `lib/serpapi/params.ts` | Request builders + deterministic `requestKey` (shared by app and gate script) | ✓ |
| `lib/serpapi/normalize.ts` | Raw JSON → domain objects (defensive) | ✓ |
| `lib/serpapi/snapshot.ts` | Snapshot entry/index format, sanitisation, file IO | ✓ |
| `lib/serpapi/reply.ts` | Hospital replies: original/translation split, reviewer-name salutation removal | ✓ |
| `lib/google-translation.ts` | Google's "(Translated by Google) … (Original) …" layout, shared by review sentences and replies | – |
| `lib/ai/sentences.ts` | NFC normalisation, marker stripping, numbered sentences | – |
| `lib/ai/rules.ts` | Deterministic pre-rules (name collision, ABHA) and the keyword fallback classifier | – |
| `lib/ai/llm-core.ts` | Shared classifier core: prompt call, output validation, cache keys, `data/classifications` file IO (no `server-only`, so scripts can import it) | – |
| `lib/ai/classifier.ts` | Claude classification with structured output, validation and caching | ✓ |
| `lib/scoring/score.ts` | Pure, unit-tested scoring: n, counts, rating split, label, baseline | – |
| `lib/server/store.ts` | Memory → snapshot → live resolution with source and fetch time | ✓ |
| `lib/server/guards.ts` | Env config, per-IP limiter, daily credit counter, Account API floor | ✓ |
| `lib/server/pipeline.ts` | Orchestration and event emission | ✓ |
| `app/api/check/route.ts` | POST → NDJSON stream (`maxDuration = 60`) | ✓ |
| `app/api/status/route.ts` | GET → live/LLM availability and snapshot combos (no secrets) | ✓ |
| `app/api/refresh/route.ts` | POST → 1-credit live refresh of one hospital | ✓ |
| `hooks/useCheckStream.ts` | Client NDJSON reader and reducer | client |
| `components/…` | UI (shadcn-style primitives, written by hand because the registry is blocked here) | client/server |

Offline scripts (repo root `scripts/`, run with `tsx`; not part of the app bundle):

| Path | Responsibility |
|---|---|
| `scripts/gate.ts` (`npm run gate`) | Day-1 data gate: fetches live SerpApi responses within a credit cap, writes sanitised snapshots to `data/snapshots/` and a verdict report to `data/gate/report.{json,md}` |
| `scripts/classify-snapshots.ts` (`npm run classify`) | Classifies every snapshot review with Claude and writes `data/classifications/<dataId>.json`, so deploys serve AI labels without request-time LLM calls |
| `scripts/make-sample.ts` | Regenerates the synthetic dev-only data in `data/sample/` |
| `scripts/dev-sample.mjs` (`npm run dev:sample`) | Starts `next dev` with `DATA_SOURCE=sample` |

## Scoring rules (code, unit-tested)

- **Window:** mentions from the last 24 months count. Older ones are shown as "older" and excluded from *n*.
- **n** = mentions in the window, excluding `NOT_PMJAY` and `NAME_COLLISION`.
- **Problem reports** = `CHARGED_FOR_PACKAGE_ITEMS` + `REFUSED`. **Cashless reports** = `CASHLESS_OK`. Disputes, delays and unclear charges are shown but are not problem reports.
- **Label:**
  - n < 3 → `too_few_reports`;
  - problem ≥ 2 and problem > 1.5 × cashless → `more_problem_reports`;
  - cashless ≥ 2 and cashless > 1.5 × problem → `more_cashless_reports`;
  - otherwise `mixed_reports`.
- **Rating split:** the mean star rating of in-window mentions, shown only when n ≥ 5.
- **City baseline:** the median rating split across hospitals that have one. Each hospital's delta = its rating split − the median.
- **Treatment:** k of n mentions where the classifier saw the chosen treatment.

## Evidence taxonomy

`CASHLESS_OK`, `CHARGED_FOR_PACKAGE_ITEMS`, `CHARGED_OUTSIDE_PACKAGE_OR_UNCLEAR`, `REFUSED`, `ELIGIBILITY_OR_SPECIALTY_DISPUTE`, `DELAY`, `NOT_PMJAY` (e.g. ABHA/OPD registration), `NAME_COLLISION` (the hospital is itself named "Ayushman" and the review has no scheme context), `MENTION_ONLY`.

## Security

- `SERPAPI_KEY` and `ANTHROPIC_API_KEY` are read only from `process.env` on the server. `server-only` guards the module graph, and nothing is `NEXT_PUBLIC_`.
- The SerpApi key travels in the URL, so URLs are never logged and errors are redacted.
- Inputs are allowlisted enums validated with zod. There is no free text to SerpApi or the LLM from users.
- Review text is untrusted: it is passed to the LLM as data, output is constrained by a JSON schema, and quotes are built by code.
- Abuse controls:
  - `LIVE_SEARCH` defaults to off;
  - a per-IP live-run limit;
  - a daily credit cap;
  - a live run is refused when the Account API reports fewer than `SERPAPI_MIN_CREDITS_LEFT`.
- Snapshots are sanitised: no `user`/`user_reviews`/`username`/`contributor_id` (reviewer identity), reviewer names in reply salutations are scrubbed, no `images`, no account metadata, no key strings.

## Environment-specific constraints

- The office network blocks serpapi.com, GitHub and Vercel. Live SerpApi calls (`npm run gate`), pushes and deploys happen from a personal network. Development here runs on snapshots and sample data.
- Live-call budget: about 40 credits for the gate, about 50 for pre-warming, about 15 for rehearsals, and the rest is held back for judging.
- After `npm run gate`, run `npm run classify` (needs `ANTHROPIC_API_KEY`) and commit `data/classifications/` together with `data/snapshots/`. Committed classifications let a deploy serve AI labels with no key and no request-time Claude calls. Without them, every card is rule-based (no key), or the first run of each combo makes up to 8 Claude calls inside the 60 s `maxDuration` of `/api/check`.

## Day-1 gate

`npm run gate` decides whether the real data supports the demo. The criteria, stated once here:

- **PASS:** at least 4 hospitals with n ≥ 5, **and** at least one hospital whose rating split is ≥ 1.0★ below the city median.
- **SOFT_PASS:** at least 4 hospitals with n ≥ 5, but no hospital ≥ 1.0★ below the median.
- **FAIL:** fewer than 4 hospitals with n ≥ 5.

`verdictFor()` in `scripts/gate.ts` is the only implementation of these thresholds; don't copy them anywhere else. It must count *n* the same way `src/lib/scoring/score.ts` does (24-month window, excluding `NOT_PMJAY` and `NAME_COLLISION`), otherwise a gate PASS may not show up in the UI. The overall result is the best verdict across the combos that were fetched.

What to do with each outcome:

- **PASS:** freeze the snapshots for the passing combos, run `npm run classify`, and fill the `<…>` placeholders in `docs/DEMO_SCRIPT.md` from `data/gate/report.md`.
- **SOFT_PASS:** keep the product. Drop the "far below the city median" contrast (use the SOFT_PASS line in DEMO_SCRIPT step 3, and don't add a contrast claim to the "Demo description" in `docs/SUBMISSION.md`), and lead the demo with problem-report counts and quotes instead. The rating split stays in the UI, where it is already gated by n ≥ 5.
- **FAIL:** within the remaining credit budget (check the cost with `--dry-run` first; about 9 credits per city/treatment combo, plus 2 per city for news, which the gate fetches unless you pass `--no-news`), re-run the gate once on the unused allowlisted cities (`npm run gate -- --cities indore,jaipur`) and/or one specific treatment (`--treatments <id>`). If that also fails, switch to the fallback idea (ReportingTime, same Maps → Reviews stack) by end of day 5 Oct 2026.

Decisions the report must settle before the snapshots are frozen:

- **`num`:** settled automatically. The gate probes whether `num` is accepted together with `query`, writes the result to `index.reviewsNum`, and the pipeline reads it. No manual decision is needed.
- **Second in-review query:** reviews are requested newest first (`sort_by=newestFirst`, `REVIEWS_SORT` in `lib/serpapi/params.ts`). `--variants N` tests a Devanagari query (`आयुष्मान`), `"golden card"` and Google's most-relevant order (`sort_by=qualityScore`) on the top N hospitals of the best combo (3 credits per hospital); the report's Variants table also shows how many of each variant's reviews fall in the last 24 months. Adopt a query only if its `newVsBase` is material, for example ≥ 3 new reviews on at least 2 of the tested hospitals. Each adopted variant costs about 8 more credits per combo and needs changes to `lib/serpapi/params.ts` and `lib/server/pipeline.ts`.
- **Run deadline:** the report's "Live call latency" table (SerpApi) and the Claude latency line printed by `npm run classify` are the inputs for tuning `RUN_BUDGET_MS` in `lib/server/pipeline.ts` (50 s against the route's 60 s `maxDuration`). Request-time Claude calls give up after 30 s with no retries (`lib/ai/classifier.ts`).
- **Combos:** choose the 1–3 city/treatment combos to keep for the demo.
