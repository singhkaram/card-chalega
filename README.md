# Card Chalega?

Compare the hospitals in your city on what Ayushman Bharat (PM-JAY) cardholders report in their Google Maps reviews.

## Tagline

Will your Ayushman card work at this hospital? Check what cardholders report before you go.

> **Status:** built for the SerpApi India Hackathon 2026 and still in progress. Real SerpApi snapshots haven't been fetched yet. The repository ships only synthetic sample data for development, so no real findings are claimed here.

## Problem

Ayushman Bharat PM-JAY promises cashless hospital care of up to ₹5 lakh per family per year. Families still find out at the billing counter that the card "won't work for this", or are asked to pay for items the package should cover.

The official hospital finder shows only on-paper empanelment, and complaints aren't published per hospital. Patient experiences that would warn families do exist, but they're spread across thousands of Google Maps reviews, one hospital at a time.

## Solution

Card Chalega? turns those scattered experiences into a comparison you can check before you go. You pick a city and a treatment. The app then:

1. Finds the 8 most-reviewed relevant hospitals with SerpApi's Google Maps engine.
2. Pulls only the reviews that mention Ayushman at each hospital, using the Google Maps Reviews engine's in-review search.
3. Uses Claude to sort each mention into one of nine evidence classes, such as "cashless OK", "asked to pay for package items" or "turned away".
4. Uses plain, unit-tested code to count the reports, compare each hospital's Ayushman-reviewer rating with the city median, and show dated, word-for-word quotes next to the hospital's own replies.

The app never gives verdicts. Every card shows its sample size (*n*), and small samples are labelled "too few reports".

Card Chalega? isn't affiliated with the National Health Authority or PM-JAY, and it isn't medical or legal advice. For official help, call 14555.

## Features

- City and treatment search across the 8 most-reviewed relevant hospitals (allowlisted cities with fixed map centres).
- Ayushman-only review evidence for each hospital, via the in-review query.
- Nine-class AI classification. The model cites sentence numbers, and code builds every quote from them.
- Rupee amounts are kept only when the digits appear in the cited text.
- The Ayushman-reviewer rating compared with the overall rating and the city median (shown only when n ≥ 5).
- Neutral evidence bars, sample sizes, a 24-month window and treatment-specific "k of n" counts.
- Hospital replies are shown. Reviewer identities are never stored or shown.
- A rights panel with the 14555 helpline, the CGRMS grievance portal, the PM-JAY hospital finder and a bilingual call-ahead script.
- Results stream in card by card. When live mode is on, each hospital has a 1-credit live refresh.
- Snapshots labelled with their fetch time, plus credit caps, per-IP limits and an Account API floor.
- A methodology page that explains every rule and limitation.

## Why SerpApi?

The evidence this app needs lives inside Google Maps reviews. In Google Maps itself, you can search the reviews of only one hospital at a time. There is no public, per-hospital record of PM-JAY complaints to use instead.

SerpApi makes the comparison possible:

- **Google Maps** gives a structured list of hospitals for a query and a map centre, each with a `data_id`, rating, review count and category.
- **Google Maps Reviews** takes that `data_id` plus an in-review search term, so one call per hospital fetches the Ayushman mentions instead of thousands of unrelated reviews.
- The responses are JSON with ratings, dates, original and translated text, and owner replies, so code can count, date and quote them reliably.
- The free **Account API** reports the remaining credits, so the app can protect its budget before any live call.

Without SerpApi there is no evidence, no city baseline and no product.

## SerpApi Integration

SerpApi is the evidence layer. Every number on a results page traces back to a SerpApi response.

### Engines and parameters

| Engine | What it gives the app | Parameters | Calls per cold run |
|---|---|---|---|
| `google_maps` | Candidate hospitals with `data_id`, rating, review count and category | `type=search`, `q=<treatment's Maps query>`, `ll=@<lat>,<lng>,13z`, `hl=en` | 1 |
| `google_maps_reviews` | Ayushman-mentioning reviews: rating, `iso_date`, original and translated text, owner response | `data_id`, `query=ayushman`, `sort_by=newestFirst`, `num` (decided by the gate, see below), `hl=en` | 8 (one per hospital, in parallel) |
| `google_news` | City-level context headlines (never affect any count) | `q=Ayushman card hospital <city>` or the Hindi equivalent, `gl=in`, `hl=en` / `hl=hi` | 2 |
| Account API | Remaining searches, checked before any live run | none | 0 (free) |

The code for these requests is in `src/lib/serpapi/params.ts`. Each request gets a deterministic cache key (a hash of the engine and parameters, never the API key). The app and the gate script share it.

### How SerpApi powers a check

1. You pick a city and a treatment. Both come from fixed lists, so no free text reaches SerpApi.
2. `google_maps` searches the treatment's Maps query around the city's fixed centre. Code keeps listings whose category fits the treatment, drops pharmacies and labs, and picks the 8 with the most reviews.
3. `google_maps_reviews` runs once per hospital with `query=ayushman` and `sort_by=newestFirst` to fetch the newest scheme mentions (one page; the card says when Google has more).
4. Claude classifies each mention. Code then scores each hospital, computes the city median and streams the results to the browser.
5. `google_news` adds a city context banner in English and Hindi.

### Credits per run

- A cold run costs about **11 searches**: 1 Maps + 8 Reviews + 2 News.
- A run served from a snapshot or the memory cache costs **0**.
- A single-hospital live refresh costs **1**.
- Every results page states its data source and how many searches it used.

### Caching and snapshots

The server resolves every SerpApi request in this order:

1. **Memory cache.** Holds live responses only, for 24 hours (Maps, News) or 7 days (Reviews).
2. **Snapshot files** in `data/snapshots/`. These are real SerpApi responses saved by `npm run gate`, each stamped with its fetch time. The page always shows that time, so a snapshot is never presented as live.
3. **Live SerpApi.** Used only when live mode is on and every guard below passes.

Snapshots are sanitised before they're saved. They contain no reviewer identities (`user`, `user_reviews`, `username`, `contributor_id`), no reviewer names in hospital-reply greetings, no images, no account metadata and no key strings.

### What the gate checks

Some SerpApi behaviour must be confirmed on real data before the demo depends on it. `npm run gate` checks it and writes `data/gate/report.md` (once the gate has run). For example, it checks:

- how many reviews the in-review query returns, and how many contain a scheme term;
- whether `num` is accepted together with `query` (it falls back to the default page size if not, and records the result for the app);
- how many reviews have dates, Hindi text and owner replies.

The verdict rules (PASS, SOFT_PASS or FAIL) are in the "Day-1 gate" section of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Guards

- Live calls are **off by default** (`LIVE_SEARCH=off`). Without live mode, the app serves snapshots only.
- A **per-IP limit** caps live runs per hour.
- A **daily credit cap** reserves a run's credits up front and refuses runs that would exceed it.
- An **Account API floor** refuses a live run when the remaining credits would drop below `SERPAPI_MIN_CREDITS_LEFT`. It fails closed: if the Account API can't answer, the run is refused.
- The per-IP limit and the daily cap live in server memory, so on serverless hosting they apply per instance. The Account API floor is the global backstop.
- `SERPAPI_KEY` is read only on the server. Request URLs (which carry the key) are never logged, and error messages are redacted.

## Architecture

Data flow for one check:

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

Main modules (all under `src/`, strict TypeScript):

| Path | Responsibility |
|---|---|
| `types/domain.ts` | Shared contracts (Hospital, Review, ClassifiedMention, HospitalScore, CheckEvent…) |
| `config/presets.ts` | Allowlisted cities, treatments, scheme terms and rights links |
| `lib/serpapi/` | SerpApi client, request builders, normalisation and snapshot format |
| `lib/ai/` | Sentence splitting, rules, and the Claude classifier with validation and caching |
| `lib/scoring/score.ts` | Pure scoring: n, counts, rating split, label and city baseline |
| `lib/server/` | Store (memory → snapshot → live), guards and the pipeline |
| `app/api/` | `check` (NDJSON stream), `status` and `refresh` route handlers |
| `hooks/useCheckStream.ts` | Client-side stream reader |

Offline scripts in `scripts/`: `gate.ts` fetches and saves snapshots, `classify-snapshots.ts` pre-computes AI classifications, and `make-sample.ts` builds the synthetic sample data.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the scoring rules, the evidence classes, the security model and the full module table.

## Tech Stack

- Next.js 16 (App Router, route handlers, NDJSON streaming)
- TypeScript (strict mode)
- Tailwind CSS 4 and Radix UI primitives (shadcn-style components)
- zod for input and output validation
- Anthropic TypeScript SDK (Claude)
- Vitest for unit tests
- Vercel as the hosting target

## Installation

You need Node.js 20.9 or later.

```bash
git clone <repository-url>
cd card-chalega
npm install
cp .env.example .env.local
```

Then fill in `.env.local` as described in the next section. Never commit `.env.local`; `.gitignore` already excludes it.

## Environment Variables

All variables are read on the server only. None of them is exposed to the browser.

| Variable | Default | What it does |
|---|---|---|
| `SERPAPI_KEY` | empty | Your SerpApi key. Needed by `npm run gate` and by live mode. |
| `ANTHROPIC_API_KEY` | empty | Your Anthropic key. Needed by `npm run classify`. At request time it's optional: without it, anything not pre-classified uses the rule-based fallback. |
| `LIVE_SEARCH` | `off` | Set to `on` to allow live SerpApi calls from the app. Live mode also needs `SERPAPI_KEY`. |
| `SERPAPI_DAILY_CREDIT_CAP` | `40` | The most live searches the server spends per UTC day. |
| `SERPAPI_MIN_CREDITS_LEFT` | `15` | The Account API floor: live runs are refused if fewer credits would remain. |
| `LIVE_RUNS_PER_IP_PER_HOUR` | `3` | Live runs allowed per client IP per hour. |

Two more variables are used only in development:

- `DATA_SOURCE=sample` serves the synthetic data in `data/sample/`. `npm run dev:sample` sets it for you. The app ignores it in production builds (`NODE_ENV=production`), and sample pages always carry a "SAMPLE DATA — not real" banner.
- `PORT` sets the port for `npm run dev:sample` (default `3123`).

## Running Locally

### 1. Try it with synthetic sample data (no keys, no network)

```bash
npm run dev:sample
```

Open http://localhost:3123. To use another port, set it first, for example `PORT=3200 npm run dev:sample`. Every hospital, review and headline in this mode is fictional.

### 2. Fetch real snapshots (open network only)

The gate needs a network that can reach serpapi.com and a `SERPAPI_KEY` in `.env.local`.

```bash
npm run gate -- --dry-run   # print the plan and its worst-case credit cost; spends nothing
npm run gate                # fetch Maps, Reviews and News snapshots (--no-news skips News)
```

The gate writes sanitised responses to `data/snapshots/` and a report to `data/gate/report.md`, including the latency of each live call. Re-running it reuses existing snapshots for free unless you pass `--refresh`.

### 3. Pre-compute the AI classifications

```bash
npm run classify
```

This needs `ANTHROPIC_API_KEY`. It writes `data/classifications/<dataId>.json` for every snapshot hospital. If any review falls back to the rules, the script exits with an error; re-run it to retry those reviews.

### 4. Run the app on the snapshots

```bash
npm run dev
```

Open http://localhost:3000. With `LIVE_SEARCH` off, the app serves only the committed snapshots and spends no credits.

### Tests and checks

```bash
npm test            # unit tests (Vitest)
npm run typecheck   # TypeScript, no emit
npm run check       # typecheck + lint + tests
```

### Deploying

1. Commit `data/snapshots/` and `data/classifications/` together, so the deploy serves AI labels without calling Claude at request time.
2. On the host (for example Vercel), set the variables from the table above. Leave `LIVE_SEARCH=off` unless you want live refreshes, and keep the caps low.
3. After deploying, open each city/treatment combo once to check it.

`docs/DEMO_SCRIPT.md` has the full pre-deploy checklist.

## Demo

- Live app: `<deployed URL>` (to be added before submission)
- Demo video: `<video link>` (to be added before submission)
- Script: [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)

## Screenshots

Screenshots will be added to `docs/screenshots/` once the real snapshots are fetched. Planned images:

- `docs/screenshots/landing.png`: the city and treatment form
- `docs/screenshots/results.png`: hospital cards with evidence bars and *n*
- `docs/screenshots/hospital-detail.png`: rating split, quotes and the hospital's reply
- `docs/screenshots/rights-panel.png`: helpline, grievance portal and call-ahead script

Any screenshot taken before then will be captioned "synthetic sample data".

## AI Usage

**In the product.** Claude (`claude-opus-5-5`), called through the Anthropic API, classifies reviews and does nothing else:

- It gives each Ayushman-mentioning review one of nine evidence classes and cites the numbers of the sentences it relied on, in a fixed JSON format.
- Code checks every sentence number and builds each quote word for word. The model never writes a quote.
- A rupee amount is kept only when its digits appear in the cited sentences.
- Review text is passed to the model as data, not instructions.
- Counting, scoring, labels and ordering are plain, unit-tested code. The AI never scores or ranks hospitals, and never makes claims about empanelment.
- If the AI is unavailable, a keyword-based fallback runs, and each card says "Rule-based (AI unavailable)".
- For deploys, `npm run classify` pre-computes the classifications so the app doesn't need to call Claude at request time.

**In development.** Development was assisted by Claude Code and other AI tools.

## Hackathon Track

Knowledge & Public Interest (SerpApi India Hackathon 2026).

## Future Improvements

Known limitations today:

- Only reviews that Google matches to "ayushman" are read. Reviews that say only "golden card", "PMJAY" or "yojana" may be missed.
- Reviewers self-select: people tend to post after very good or very bad experiences.
- Some reviews are shown with Google's translation, and translation errors can affect labels.
- Only the 8 most-reviewed matching hospitals near the city centre are compared.
- A refusal can reflect specialty-specific empanelment rather than a breach of the scheme.

Ideas for next steps:

- Extra in-review queries (Devanagari "आयुष्मान", "golden card") if the gate shows they find more reports.
- One-tap complaint drafts built from the evidence.
- A district view for NGOs and journalists.
- State schemes such as Aarogyasri.
- A WhatsApp bot for ASHA workers.
- A shared store for the rate limit and daily cap, so they apply across server instances.

## License

Released under the MIT License. See [LICENSE](LICENSE).
