# Submission copy — SerpApi India Hackathon 2026

> Before submitting, replace `<…>` placeholders and verify every statistic from a primary source (PIB / NHA / Lok Sabha). Remove any statistic you can't verify.

**Project title:** Card Chalega?

**Tagline:** Will your Ayushman card work at this hospital? Check what cardholders report before you go.

**Track:** Knowledge & Public Interest

**Short description (≤ 200 chars):**
Compares every hospital in your city on what Ayushman (PM-JAY) cardholders report in Google Maps reviews (cashless, charged or refused), with counts, a city baseline and dated quotes.

**Long description:**
Ayushman Bharat PM-JAY promises cashless hospital care of up to ₹5 lakh per family per year. Families still find out at the billing counter that the card "won't work for this", or are asked to pay for items the package should cover. The official hospital finder shows only on-paper empanelment, and complaints aren't published per hospital.

Card Chalega? turns scattered patient experiences into a comparison you can check before you go. Pick a city and a treatment:

1. SerpApi's Google Maps engine finds the most-reviewed relevant hospitals.
2. The Google Maps Reviews engine's in-review query pulls only the reviews that mention Ayushman at each one.
3. Claude sorts every mention into a nine-category taxonomy, separating real problems from legitimate disputes and noise.
4. Deterministic, unit-tested code turns that into neutral evidence bars with sample sizes, compares each hospital's Ayushman-reviewer rating with the city median, and shows dated, verbatim quotes alongside the hospital's own replies.

A rights panel gives the 14555 helpline, the grievance portal, and a bilingual call-ahead script.

**Problem:** Being covered on paper doesn't guarantee cashless treatment at the counter. Patient experiences that would warn families exist, but they are spread across thousands of reviews, one hospital at a time.

**Solution:** A cross-hospital, baseline-adjusted, quote-grounded evidence view built on live search data, with explicit uncertainty (n, too-few-reports states) and no verdicts.

**Features:**
- City and treatment search across the 8 most-reviewed relevant hospitals (allowlisted cities, hard-coded coordinates)
- Ayushman-only review evidence per hospital via the in-review query
- Nine-category AI classification, with quotes assembled by code from cited sentence ids
- Rupee amounts accepted only when the digits appear in the cited text
- The rating among Ayushman reviewers compared with the overall rating and the city median (shown only at n ≥ 5)
- Neutral evidence bars, sample sizes, a 24-month window and treatment-specific "k of n" counts
- Hospital replies shown; reviewer identities never stored
- Rights panel (14555, CGRMS, PM-JAY finder) and a bilingual call-ahead script
- Results stream in card by card; a 1-credit live refresh per hospital
- Snapshot cache labelled with fetch time; credit caps, per-IP limits and an Account API floor
- A methodology page explaining every rule and limitation

**SerpApi integration:**
- `google_maps` (`type=search`, `q`, `ll`) finds the candidate hospitals and supplies `data_id`, rating, review count and types.
- `google_maps_reviews` (`data_id`, `query=ayushman`) returns only the scheme-related reviews, with rating, `iso_date`, original and translated text, and the owner's response. This is the core evidence.
- `google_news` (`gl=in`, `hl=en|hi`) adds city-level context.
- The Account API (free) provides a credit floor check before any live run.
- About 11 searches per new city/treatment; 0 when served from cache or snapshot. Without SerpApi there is no evidence, no baseline and no product.

**AI usage (in the product):** Claude (`claude-opus-5-5`) is used for classification only, through the Anthropic API with structured JSON output and server-side refusal fallback. Every output is validated in code (sentence ids, amounts). If the AI is unavailable, a visible rule-based fallback runs instead. AI never scores, ranks or makes claims about empanelment.

**AI disclosure (development):** Development was assisted by Claude Code and other AI tools. This project was started on Oct 3, 2026 for this hackathon; it is not an existing project.

**Tech stack:** Next.js 16 (App Router, route handlers, NDJSON streaming), TypeScript (strict), Tailwind CSS 4, Radix UI primitives (shadcn-style), zod, Anthropic TypeScript SDK, Vitest, Vercel.

**GitHub description:** Compare hospitals on what Ayushman (PM-JAY) cardholders report: SerpApi Google Maps + Reviews + News, grounded AI classification, neutral evidence. SerpApi India Hackathon 2026.

**Demo description:** A 3-minute walkthrough: pick a city and treatment, watch the 8 hospital cards stream in, open a hospital and compare its Ayushman-reviewer rating with the city median (shown when n ≥ 5), read the Hindi quotes and the hospital's reply, use the rights panel, then do a live 1-credit refresh to prove the data is real.
