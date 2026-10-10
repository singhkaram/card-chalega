# Demo video script (target 2:50)

Record with snapshot data that the day-1 gate fetched, so the footer shows "Snapshot fetched … IST". Do one **live** single-hospital refresh on camera (1 credit) to prove the data is real. Before recording, check that `total_searches_left` is above 20 (the gate script prints it).

Replace every `<…>` with values from `data/gate/report.md`. Don't quote any number that isn't on screen.

### Pre-deploy data checklist (before recording)

1. On a personal network, run `npm run gate` (it fetches news too; `--no-news` turns that off). Act on the verdict as described in the "Day-1 gate" section of `docs/ARCHITECTURE.md`.
2. Run `npm run classify`. It writes `data/classifications/<dataId>.json`. Re-run it until it exits 0 with no "fell back to the rules" warning (the script exits 1 when any review fell back).
3. Locally, with `DATA_SOURCE` unset and `ANTHROPIC_API_KEY` empty, run `npm run dev` and open `/check?city=<city>&treatment=<treatment>` for every snapshot combo. Confirm that no card says "Rule-based (AI unavailable)" and the progress stepper says "AI classify". Check that the "In the news" card appears. If the snapshots were fetched without news, run `npm run gate -- --cities <same cities>`; it reuses the existing snapshots and spends only 2 credits per city.
4. Commit `data/snapshots/` and `data/classifications/` together.
5. After deploying, open each combo once on the deployed URL.

---

### 0:00–0:15 — Problem
**Screen:** landing page, hero visible.
**Voice:** "Fifty-five crore Indians are covered by Ayushman Bharat: up to five lakh rupees of free, cashless hospital care a year. But families often find out at the billing counter that the card 'won't work for this'. The official finder only tells you which hospitals are on the scheme on paper." *(verify the coverage figure from PIB before recording)*

### 0:15–0:30 — Solution
**Screen:** cursor on the tagline, then the form.
**Voice:** "Google Maps lets you search one hospital's reviews at a time. Card Chalega compares every hospital in your city on what Ayushman cardholders actually report: cashless, asked to pay, or turned away."

### 0:30–1:30 — Live product
1. Select **<city>** and **<treatment>**, then press **Check**. *(The progress stepper runs: Maps → Reviews 8/8 → AI classify → Scores.)*
   "It finds the eight most-reviewed relevant hospitals, then pulls only the reviews that mention Ayushman."
2. Cards stream in. Point at the evidence bars and *n*.
   "Every card shows how many reports there are. Nothing is shown as a verdict, and small samples are labelled 'too few reports'."
3. Open **<hospital X>**.
   "Overall it's rated <4.6> stars from <2,300> reviews. But Ayushman-mentioning reviewers rate it <2.0> (n=<9>), against a city median of <3.3>."
   *(PASS only. On SOFT_PASS, open the hospital with the most problem reports instead and omit the median comparison: "Overall it's rated <4.6> stars, but <k> of <n> Ayushman-mentioning reviewers report being asked to pay or turned away.")*
4. Scroll to the quotes: a Hindi original, its translation, an approximate date, a rupee amount chip and the hospital's reply.
   "Every report is a verbatim quote linked to the original review, and we show the hospital's reply too."
5. Rights panel: 14555, the grievance portal, and the call-ahead script with Copy.
   "If you're turned away, here is exactly what to do. For hospitals with too few reports, call ahead with this script."
6. Press **Refresh live (1 search)** on one card. The badge changes to "Live · just now".
   "That was a live SerpApi call. The data is real."

### 1:30–2:00 — SerpApi workflow
**Screen:** the Methodology page, or the architecture diagram from the README.
**Voice:** "SerpApi is the evidence layer. Google Maps finds the hospitals and their place IDs. Google Maps Reviews, with its in-review query, returns only the Ayushman mentions for each hospital. Google News adds city context in English and Hindi. That's about eleven searches for a new city, and zero when cached. Snapshots are stamped with their fetch time, and live mode has a daily credit cap and a per-user limit."

### 2:00–2:30 — AI and technical depth
**Voice:** "Claude sorts each mention into nine categories. It separates real problems from legitimate disputes, such as a specialty the hospital isn't empanelled for, and from hospitals that are simply named 'Ayushman'. The AI only cites sentence numbers; our code builds every quote and checks every rupee amount, so nothing is invented. The counts, the sample-size thresholds and the city baseline are plain, unit-tested code. If the AI is unavailable, a rule-based classifier takes over and says so."

### 2:30–2:50 — Impact and future
**Voice:** "For a family, this turns an unknown at the billing counter into a decision made at home. Next: one-tap complaint drafts built from the evidence, a district view for NGOs and journalists, state schemes like Aarogyasri, and a WhatsApp bot for ASHA workers. Card Chalega: check before you go."

---

**Recording checklist:** 1080p, browser zoom at 110%, notifications off, mouse movements slow. No `.env.local`, terminal or DevTools on screen. Do one mobile-width pass (375px) for 3 seconds during the product section if time allows.
