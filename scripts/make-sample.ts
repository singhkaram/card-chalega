/*
 * Generates SYNTHETIC dev-only sample data in data/sample/ (same format as
 * data/snapshots/, keys from requestKey()). Every hospital, review and headline
 * is fictional; names carry "(Sample)", links point to example.com, phone
 * numbers are 0000 patterns. Served only when DATA_SOURCE=sample outside production.
 *
 *   npx tsx scripts/make-sample.ts          # reference date fixed below (deterministic)
 *   npx tsx scripts/make-sample.ts --now    # date reviews relative to today
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { CITIES, TREATMENTS } from "@/config/presets";
import { mapsSearchRequest, newsRequest, requestKey, reviewsRequest, storableParams, type SerpRequest } from "@/lib/serpapi/params";
import { comboId, SNAPSHOT_VERSION, type SnapshotCombo, type SnapshotEntry, type SnapshotIndex } from "@/lib/serpapi/snapshot";
import type { CityId, TreatmentId } from "@/types/domain";

const NOTE = "SYNTHETIC SAMPLE DATA — dev only";
const REF = process.argv.includes("--now") ? new Date() : new Date("2026-10-03T06:00:00Z");
const REVIEWS_NUM = 20;
const OUT = path.join(process.cwd(), "data", "sample");
const DAY = 86_400_000;

// ---------- compact specs ----------

/** One review: months ago, stars, text (English/Hinglish) or Hindi + translation, optional owner reply. */
interface R {
  m: number;
  r: number;
  en?: string;
  hi?: string;
  tr?: string;
  reply?: string;
}

interface H {
  name: string;
  rating: number;
  reviews: number;
  type: string;
  types: string[];
  dLat: number;
  dLng: number;
  items: R[];
}

interface Dropped {
  name: string;
  rating: number;
  reviews: number;
  type: string;
}

interface ComboSpec {
  city: CityId;
  treatment: TreatmentId;
  tag: string;
  hospitals: H[];
  dropped: Dropped[];
  newsEn: string[];
  newsHi: string[];
}

const LUCKNOW: ComboSpec = {
  city: "lucknow",
  treatment: "general",
  tag: "lko",
  newsEn: [
    "Sample headline: District panel reviews Ayushman card claims at private hospitals",
    "Sample headline: Ayushman card registration camp held at community centre",
    "Sample headline: Health department reminds hospitals of PM-JAY cashless rules",
  ],
  newsHi: [
    "Sample headline (नमूना): आयुष्मान कार्ड बनाने के लिए विशेष शिविर",
    "Sample headline (नमूना): अस्पतालों को कैशलेस इलाज के निर्देश",
  ],
  dropped: [
    { name: "Sample Medicos & Pharmacy (Sample)", rating: 4.4, reviews: 910, type: "Pharmacy" },
    { name: "Sample Pathology Lab (Sample)", rating: 4.2, reviews: 610, type: "Medical laboratory" },
  ],
  hospitals: [
    {
      name: "Sample District Government Hospital (Sample)",
      rating: 3.6,
      reviews: 3120,
      type: "Government hospital",
      types: ["Government hospital", "Hospital"],
      dLat: 0.004,
      dLng: -0.006,
      items: [
        { m: 1, r: 4, hi: "सरकारी अस्पताल है, आयुष्मान कार्ड से ऑपरेशन मुफ्त हुआ लेकिन भीड़ बहुत है।", tr: "It is a government hospital, the operation was free with the Ayushman card but it is very crowded." },
        { m: 3, r: 2, en: "Ayushman card verification took the whole day, we were sent from one counter to another. Treatment started only the next morning." },
        { m: 5, r: 3, en: "Ayushman card se free ilaaj hua par dawai bahar se laani padi, approx 800 rupaye." },
        { m: 10, r: 4, en: "Free treatment with Ayushman card. Doctors were busy but helpful." },
        { m: 13, r: 2, hi: "आयुष्मान कार्ड का ई-केवाईसी नहीं हो रहा था, तीन दिन चक्कर लगाने पड़े।", tr: "The e-KYC of the Ayushman card was not happening, we had to make rounds for three days." },
        { m: 20, r: 5, en: "Very good care for my grandmother under Ayushman Bharat, everything was cashless." },
        { m: 22, r: 3, en: "Came only to make an ABHA health ID at the Ayushman counter. Long queue, got it done in 2 hours." },
      ],
    },
    {
      name: "Shanti Sample Hospital (Sample)",
      rating: 4.6,
      reviews: 2341,
      type: "Private hospital",
      types: ["Private hospital", "Hospital"],
      dLat: -0.008,
      dLng: 0.011,
      items: [
        { m: 1, r: 1, en: "Admitted my father under the Ayushman card for gall bladder surgery. At discharge they asked us to pay ₹18,000 for medicines and implants which should be covered in the package. No bill was given.", reply: "We regret your experience. Please contact our Ayushman help desk with your file number so we can review the billing. — Hospital administration (sample)" },
        { m: 2, r: 1, hi: "आयुष्मान कार्ड दिखाया तो बोले कि यहाँ अभी योजना बंद है, नकद जमा करो। मरीज़ को दूसरे अस्पताल ले जाना पड़ा।", tr: "When we showed the Ayushman card they said the scheme is closed here right now, deposit cash. We had to take the patient to another hospital." },
        { m: 4, r: 2, en: "Ayushman card se admit kiya but har din 2000 rs dawai ke naam pe le lete the. Staff bolta hai ye package me nahi aata." },
        { m: 6, r: 5, en: "Doctors are very good. My mother's knee operation was done completely free with the Ayushman card, no money asked at all. Thanks to the Ayushman desk staff.", reply: "Thank you for your feedback. Wishing your mother a quick recovery." },
        { m: 7, r: 1, hi: "आयुष्मान कार्ड होने के बावजूद ऑपरेशन से पहले 25,000 रुपये जमा करवाए, बोले बाद में वापस होंगे, अभी तक नहीं मिले।", tr: "Despite having the Ayushman card they made us deposit 25,000 rupees before the operation, said it would be refunded later, still not received." },
        { m: 9, r: 2, en: "Approval for Ayushman took 4 days. The patient was kept waiting in emergency and we were told to wait for the insurance team." },
        { m: 11, r: 1, en: "Ayushman card wale patients ke saath bura vyavhar. Bed nahi hai bol ke mana kar diya, private me turant bed mil gaya." },
        { m: 14, r: 3, en: "Treatment under Ayushman was cashless but they charged ₹3,500 for some tests which they said are outside the package. Not sure if that is correct." },
        { m: 19, r: 2, en: "They said my Ayushman card is valid only for certain surgeries and my mother's treatment is not covered here, go to the government hospital." },
        { m: 27, r: 1, en: "Took ₹10,000 extra from an Ayushman patient for blood. Very bad." },
      ],
    },
    {
      name: "Gomti Sample Medical Centre (Sample)",
      rating: 4.1,
      reviews: 1580,
      type: "Hospital",
      types: ["Hospital", "Medical Center"],
      dLat: 0.012,
      dLng: 0.007,
      items: [
        { m: 0.5, r: 5, en: "Got my wife's delivery done under Ayushman Bharat. Fully cashless, they even arranged the medicines. Not a single rupee paid.", reply: "Thank you for your kind words. Wishing your family good health." },
        { m: 2, r: 5, hi: "आयुष्मान कार्ड से पिताजी का हर्निया ऑपरेशन हुआ, एक भी पैसा नहीं लगा। आयुष्मान काउंटर का स्टाफ बहुत मददगार है।", tr: "Father's hernia operation was done with the Ayushman card, not a single paisa was spent. The staff at the Ayushman counter are very helpful." },
        { m: 3, r: 4, en: "Ayushman card se ilaaj free hua, bas approval me 1 din laga. Overall theek hai." },
        { m: 5, r: 5, en: "PMJAY golden card accepted without any hassle. Surgery and a 5 day stay were free." },
        { m: 8, r: 3, en: "Ayushman treatment was free but we bought some medicines from outside, about ₹1,200. Staff said those were not in the list." },
        { m: 12, r: 5, hi: "आयुष्मान योजना के तहत माँ का इलाज मुफ्त हुआ। डॉक्टर अच्छे हैं।", tr: "Mother's treatment was free under the Ayushman scheme. The doctors are good." },
        { m: 16, r: 4, en: "Used the Ayushman card for my uncle's appendix surgery. Cashless, though the ward was crowded." },
        { m: 29, r: 2, en: "Ayushman card was not accepted for my brother's treatment back then, they said the specialty is not empanelled." },
      ],
    },
    {
      name: "Nawab Sample Heart & Multispeciality Hospital (Sample)",
      rating: 4.4,
      reviews: 980,
      type: "Private hospital",
      types: ["Private hospital", "Heart hospital"],
      dLat: -0.015,
      dLng: -0.004,
      items: [
        { m: 2, r: 4, en: "Angioplasty for my father was done under the Ayushman card, cashless. We only paid for the attendant's food." },
        { m: 4, r: 2, en: "Ayushman me stent ka paisa alag se manga, 40 hazaar bola. Humne mana kiya to discharge me delay kiya.", reply: "Stents are covered under the PM-JAY package at our hospital. Please contact the Ayushman desk so we can look into this. — Patient relations (sample)" },
        { m: 7, r: 3, en: "Mixed experience. Ayushman approval came after 2 days. The treatment itself was free." },
        { m: 9, r: 5, hi: "आयुष्मान कार्ड से दिल का ऑपरेशन बिल्कुल मुफ्त हुआ। धन्यवाद।", tr: "The heart operation was completely free with the Ayushman card. Thank you." },
        { m: 15, r: 1, en: "They refused to take my Ayushman card saying the quota for this month is full." },
        { m: 21, r: 3, en: "Asked to pay ₹5,000 for consumables while admitted on Ayushman. Not sure if it was allowed." },
      ],
    },
    {
      name: "Aayushman Sample Care (Sample)",
      rating: 4.2,
      reviews: 760,
      type: "Hospital",
      types: ["Hospital"],
      dLat: 0.018,
      dLng: -0.012,
      items: [
        { m: 1, r: 5, en: "Aayushman Sample Care has very good doctors and clean rooms. The doctor explained everything patiently." },
        { m: 3, r: 4, en: "Aayushman hospital ka staff accha hai, emergency me jaldi dekha." },
        { m: 6, r: 1, hi: "आयुष्मान हॉस्पिटल में बहुत महंगा इलाज है, बिल बहुत ज़्यादा बना।", tr: "Treatment at Aayushman hospital is very expensive, the bill was very high." },
        { m: 8, r: 2, en: "Ironically, Aayushman Sample Care did not accept my Ayushman Bharat golden card. They said they are not empanelled for this treatment." },
        { m: 12, r: 5, en: "Got cataract surgery done here with the Ayushman card (PMJAY), totally cashless." },
        { m: 18, r: 3, en: "Visited Aayushman Sample Care for a fever. Average experience." },
      ],
    },
    {
      name: "Hazratganj Sample Eye & General Hospital (Sample)",
      rating: 4.3,
      reviews: 520,
      type: "Hospital",
      types: ["Hospital", "Eye care center"],
      dLat: -0.003,
      dLng: 0.016,
      items: [
        { m: 2, r: 4, en: "Cataract operation for my mother under the Ayushman card. Free, but a lens upgrade was offered for ₹6,000 which we declined." },
        { m: 5, r: 2, en: "Ayushman card pe bola sirf aankh ka ilaaj hoga, general surgery ke liye mana kar diya." },
        { m: 10, r: 3, en: "Asked about Ayushman at reception, they told us to come back with Aadhaar next time." },
        { m: 26, r: 1, hi: "आयुष्मान कार्ड पर भी 7000 रुपये लिए।", tr: "They took 7000 rupees even on the Ayushman card." },
      ],
    },
    {
      name: "Chowk Sample Nursing Home (Sample)",
      rating: 3.9,
      reviews: 410,
      type: "Nursing home",
      types: ["Nursing home"],
      dLat: 0.021,
      dLng: 0.003,
      items: [
        { m: 4, r: 1, en: "Ayushman card dekh ke bola yahan nahi chalta. Very rude." },
        { m: 11, r: 4, en: "Small nursing home, they helped us with the Ayushman paperwork and the treatment was free." },
      ],
    },
    {
      name: "Aliganj Sample Children Hospital (Sample)",
      rating: 4.0,
      reviews: 350,
      type: "Children's hospital",
      types: ["Children's hospital", "Hospital"],
      dLat: -0.019,
      dLng: 0.009,
      items: [
        { m: 3, r: 5, en: "Came for the ABHA and Ayushman card registration camp, done quickly. The children's ward is clean." },
        { m: 9, r: 4, hi: "आयुष्मान कार्ड से बच्चे का इलाज हुआ, कोई पैसा नहीं लगा।", tr: "The child's treatment was done with the Ayushman card, no money was spent." },
      ],
    },
  ],
};

const PATNA: ComboSpec = {
  city: "patna",
  treatment: "dialysis",
  tag: "pat",
  newsEn: [
    "Sample headline: Free dialysis sessions under Ayushman scheme expand to more centres",
    "Sample headline: Officials review complaints about extra charges for dialysis kits",
  ],
  newsHi: [
    "Sample headline (नमूना): आयुष्मान कार्ड से मुफ्त डायलिसिस की सुविधा बढ़ी",
    "Sample headline (नमूना): अतिरिक्त शुल्क की शिकायतों पर समीक्षा बैठक",
  ],
  dropped: [{ name: "Sample Kidney Diagnostics (Sample)", rating: 4.5, reviews: 820, type: "Diagnostic center" }],
  hospitals: [
    {
      name: "Sample Medical College Hospital, Patna (Sample)",
      rating: 3.8,
      reviews: 4210,
      type: "Government hospital",
      types: ["Government hospital", "Hospital"],
      dLat: 0.006,
      dLng: 0.01,
      items: [
        { m: 1, r: 3, hi: "सरकारी अस्पताल में आयुष्मान कार्ड से डायलिसिस मुफ्त है लेकिन लाइन बहुत लंबी है।", tr: "In the government hospital dialysis is free with the Ayushman card but the queue is very long." },
        { m: 3, r: 4, en: "Dialysis is free under Ayushman Bharat. The machines are old but the staff try their best." },
        { m: 6, r: 2, en: "Waited 5 days for an Ayushman dialysis slot. The patient's condition got worse." },
        { m: 10, r: 4, en: "Ayushman card se free ilaaj hua, doctor log ache hai." },
        { m: 15, r: 3, en: "Medicines for dialysis had to be bought outside for about ₹2,000 a month even with Ayushman." },
        { m: 23, r: 2, en: "The Ayushman counter was closed on Sunday, an emergency patient had to wait till Monday for approval." },
      ],
    },
    {
      name: "Patliputra Sample Hospital (Sample)",
      rating: 4.5,
      reviews: 1890,
      type: "Private hospital",
      types: ["Private hospital", "Hospital"],
      dLat: -0.009,
      dLng: -0.007,
      items: [
        { m: 1, r: 1, en: "Ayushman card hone ke baad bhi har dialysis ka 1500 rupay liya. Bole kit ka paisa alag lagta hai." },
        { m: 2, r: 1, hi: "आयुष्मान कार्ड लेकर गए तो बोले डायलिसिस इस योजना में यहाँ नहीं होता, पैसे दो।", tr: "When we went with the Ayushman card they said dialysis is not done under this scheme here, pay money." },
        { m: 5, r: 2, en: "Paid ₹12,000 for my uncle's dialysis and medicines despite the Ayushman card. They did not give a proper bill.", reply: "We are sorry to hear this. Ayushman-covered dialysis is cashless at our hospital; please share your registration number with our help desk. — Hospital management (sample)" },
        { m: 8, r: 3, en: "Ayushman approval for dialysis took a week. In the meantime we paid for two sessions." },
        { m: 12, r: 1, en: "Ayushman wale mareez ko bed nahi diya, private patient ko turant admit kar liya." },
        { m: 17, r: 4, en: "Kidney stone surgery was cashless under Ayushman. Good doctors." },
        { m: 20, r: 2, hi: "डायलिसिस के लिए आयुष्मान कार्ड पर भी हर बार 800 रुपये लगते हैं।", tr: "Even on the Ayushman card it costs 800 rupees every time for dialysis." },
      ],
    },
    {
      name: "Sone Sample Multispeciality Hospital (Sample)",
      rating: 4.2,
      reviews: 980,
      type: "Private hospital",
      types: ["Private hospital"],
      dLat: 0.014,
      dLng: -0.011,
      items: [
        { m: 1, r: 4, en: "Dialysis started under Ayushman after the approval came in a few hours. No charges." },
        { m: 4, r: 2, hi: "आयुष्मान कार्ड से इलाज तो हुआ लेकिन डिस्चार्ज के समय 3000 रुपये 'अन्य खर्च' के नाम पर लिए।", tr: "The treatment was done with the Ayushman card but at discharge they took 3000 rupees in the name of 'other expenses'." },
        { m: 8, r: 3, en: "Made my ABHA card here for free at the Ayushman kiosk." },
        { m: 16, r: 1, en: "Ayushman card pe dialysis ke liye mana kar diya, bole package khatam ho gaya." },
      ],
    },
    {
      name: "Bodh Sample Nephrology & Multispeciality Hospital (Sample)",
      rating: 4.0,
      reviews: 720,
      type: "Hospital",
      types: ["Hospital", "Nephrologist"],
      dLat: -0.016,
      dLng: 0.013,
      items: [
        { m: 2, r: 5, en: "The nephrologist is excellent. Dialysis was done on the Ayushman card without any payment." },
        { m: 7, r: 2, en: "They said the Ayushman card does not cover dialysis for patients registered outside the state." },
        { m: 28, r: 1, en: "Charged for dialysis under Ayushman." },
      ],
    },
    {
      name: "Ganga Sample Kidney & Dialysis Centre (Sample)",
      rating: 4.3,
      reviews: 640,
      type: "Dialysis center",
      types: ["Dialysis center", "Medical Center"],
      dLat: 0.003,
      dLng: -0.015,
      items: [
        { m: 1, r: 5, hi: "पिताजी का हफ्ते में दो बार डायलिसिस आयुष्मान कार्ड से मुफ्त होता है। स्टाफ अच्छा है।", tr: "Father's dialysis twice a week is free with the Ayushman card. The staff is good.", reply: "धन्यवाद! हम आपके पिताजी के अच्छे स्वास्थ्य की कामना करते हैं।" },
        { m: 2, r: 5, en: "Dialysis sessions under Ayushman Bharat are completely cashless here. They even provide the dialyser kit." },
        { m: 4, r: 4, en: "Ayushman card se dialysis free hai, bas slot ke liye 2-3 din wait karna padta hai." },
        { m: 6, r: 4, en: "Good dialysis unit. Ayushman card accepted, no charges except parking." },
        { m: 9, r: 2, en: "They asked ₹500 per dialysis session for kit charges even though we have the Ayushman card.", reply: "Kits are included in the PM-JAY dialysis package. We have refunded the amount and retrained the billing team. — Centre manager (sample)" },
        { m: 14, r: 5, hi: "आयुष्मान योजना से माँ का किडनी का इलाज और डायलिसिस मुफ्त हुआ।", tr: "Mother's kidney treatment and dialysis were free under the Ayushman scheme." },
        { m: 25, r: 3, en: "Ayushman dialysis was free but the waiting time was very long." },
      ],
    },
    {
      name: "Kadam Sample Nursing Home (Sample)",
      rating: 3.7,
      reviews: 300,
      type: "Nursing home",
      types: ["Nursing home"],
      dLat: 0.019,
      dLng: 0.006,
      items: [
        { m: 3, r: 3, en: "Ayushman ka board laga hai par staff ko kuch pata nahi." },
        { m: 13, r: 1, en: "Not accepting the Ayushman card for dialysis. Asked us to go elsewhere." },
      ],
    },
  ],
};

// ---------- builders ----------

const hex16 = (n: number) => n.toString(16).padStart(16, "0");

function ids(tag: string, i: number) {
  const city = tag === "lko" ? 0x5a1 : 0x5a2;
  return {
    dataId: `0x${hex16(city * 0x1000 + i)}:0x${hex16(0xa0000 + city * 0x100 + i)}`,
    placeId: `ChIJ_SAMPLE_${tag}_${String(i).padStart(2, "0")}`,
    cid: String(1_000_000_000_000 + city * 100 + i),
  };
}

function isoAgo(months: number, hourSeed: number): string {
  const t = REF.getTime() - Math.round(months * 30.4 * DAY) - (hourSeed % 11) * 3_600_000;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function relative(months: number): string {
  if (months < 1) return `${Math.max(1, Math.round((months * 30.4) / 7))} weeks ago`;
  if (months < 1.5) return "a month ago";
  if (months < 12) return `${Math.round(months)} months ago`;
  if (months < 24) return "a year ago";
  return `${Math.floor(months / 12)} years ago`;
}

function reviewItem(tag: string, h: number, j: number, spec: R): Record<string, unknown> {
  const reviewId = `sample_${tag}_${String(h).padStart(2, "0")}_r${String(j + 1).padStart(2, "0")}`;
  const isoDate = isoAgo(spec.m, h * 7 + j);
  const item: Record<string, unknown> = {
    link: `https://example.com/review/${reviewId}`,
    rating: spec.r,
    date: relative(spec.m),
    iso_date: isoDate,
    review_id: reviewId,
  };
  if (spec.hi) {
    item.snippet = `(Translated by Google) ${spec.tr ?? ""}\n\n(Original)\n${spec.hi}`;
    item.extracted_snippet = { original: spec.hi, translated: spec.tr };
  } else {
    item.snippet = spec.en;
    item.extracted_snippet = { original: spec.en };
  }
  item.likes = (h + j * 3) % 5;
  if (spec.reply) {
    const replyMonths = Math.max(0.1, spec.m - 0.2);
    item.response = { date: relative(replyMonths), iso_date: isoAgo(replyMonths, h + j), snippet: spec.reply };
  }
  return item;
}

function entry(req: SerpRequest, fetchedAt: string, response: unknown): SnapshotEntry & { note: string } {
  return { version: SNAPSHOT_VERSION, key: requestKey(req), engine: req.engine, params: storableParams(req.params), fetchedAt, note: NOTE, response };
}

function at(minutesAfterRef: number): string {
  return new Date(REF.getTime() + 2 * 3_600_000 + minutesAfterRef * 60_000).toISOString();
}

function buildCombo(spec: ComboSpec, entries: SnapshotEntry[]): SnapshotCombo {
  const city = CITIES[spec.city];
  const treatment = TREATMENTS[spec.treatment];
  const mapsReq = mapsSearchRequest(city, treatment);
  const mapsAt = at(spec.tag === "lko" ? 0 : 30);

  const local = [
    ...spec.hospitals.map((h, i) => {
      const id = ids(spec.tag, i + 1);
      return {
        title: h.name,
        place_id: id.placeId,
        data_id: id.dataId,
        data_cid: id.cid,
        gps_coordinates: { latitude: +(city.lat + h.dLat).toFixed(6), longitude: +(city.lng + h.dLng).toFixed(6) },
        rating: h.rating,
        reviews: h.reviews,
        type: h.type,
        types: h.types,
        address: `${10 + i} Sample Marg, ${city.name}, ${city.state} (Sample)`,
        phone: `+91 00000 000${String(i + 1).padStart(2, "0")}`,
        website: `https://example.com/sample-hospital/${spec.tag}-${i + 1}`,
      };
    }),
    ...spec.dropped.map((d, k) => {
      const id = ids(spec.tag, 90 + k);
      return {
        title: d.name,
        place_id: id.placeId,
        data_id: id.dataId,
        data_cid: id.cid,
        gps_coordinates: { latitude: +(city.lat + 0.001 * (k + 1)).toFixed(6), longitude: +(city.lng - 0.001 * (k + 1)).toFixed(6) },
        rating: d.rating,
        reviews: d.reviews,
        type: d.type,
        types: [d.type],
        address: `${50 + k} Sample Bazaar, ${city.name}, ${city.state} (Sample)`,
        phone: `+91 00000 001${String(k).padStart(2, "0")}`,
      };
    }),
  ]
    // SerpApi orders by relevance, not review count: interleave so the app's own sort is exercised.
    .sort((a, b) => (a.title.length % 3) - (b.title.length % 3) || a.title.localeCompare(b.title))
    .map((item, i) => ({ position: i + 1, ...item }));

  entries.push(
    entry(mapsReq, mapsAt, {
      search_metadata: { status: "Success", created_at: mapsAt.replace("T", " ").replace(/\.\d{3}Z$/, " UTC"), total_time_taken: 1.42 },
      search_parameters: { engine: "google_maps", type: "search", q: treatment.mapsQuery, ll: mapsReq.params.ll, hl: "en" },
      local_results: local,
    }),
  );

  // Index order = display order = most reviewed first (as the gate script selects).
  const order = spec.hospitals.map((h, i) => ({ h, i })).sort((a, b) => b.h.reviews - a.h.reviews);
  const hospitals = order.map(({ h, i }, rank) => {
    const id = ids(spec.tag, i + 1);
    const req = reviewsRequest(id.dataId, { num: REVIEWS_NUM });
    const fetchedAt = at((spec.tag === "lko" ? 1 : 31) + rank);
    entries.push(
      entry(req, fetchedAt, {
        search_metadata: { status: "Success", created_at: fetchedAt.replace("T", " ").replace(/\.\d{3}Z$/, " UTC"), total_time_taken: 2.1 },
        search_parameters: { engine: "google_maps_reviews", data_id: id.dataId, query: "ayushman", sort_by: req.params.sort_by, num: String(REVIEWS_NUM), hl: "en" },
        place_info: { title: h.name, address: `${10 + i} Sample Marg, ${city.name}, ${city.state} (Sample)`, rating: h.rating, reviews: h.reviews, type: h.type },
        reviews: h.items.map((r, j) => reviewItem(spec.tag, i + 1, j, r)),
      }),
    );
    return { dataId: id.dataId, reviewsKey: requestKey(req) };
  });

  const newsKeys: { en?: string; hi?: string } = {};
  for (const lang of ["en", "hi"] as const) {
    const req = newsRequest(city, lang);
    const titles = lang === "en" ? spec.newsEn : spec.newsHi;
    const fetchedAt = at((spec.tag === "lko" ? 12 : 42) + (lang === "en" ? 0 : 1));
    entries.push(
      entry(req, fetchedAt, {
        search_metadata: { status: "Success", created_at: fetchedAt.replace("T", " ").replace(/\.\d{3}Z$/, " UTC"), total_time_taken: 0.9 },
        search_parameters: { engine: "google_news", q: req.params.q, gl: "in", hl: lang },
        news_results: titles.map((title, k) => {
          const iso = isoAgo(0.1 * (k + 1), k);
          return {
            position: k + 1,
            title,
            source: { name: lang === "en" ? "Sample News Desk" : "नमूना समाचार (Sample)" },
            link: `https://example.com/news/sample-${spec.tag}-${lang}-${k + 1}`,
            date: `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}, 07:00 AM, +0000 UTC`,
            iso_date: iso,
          };
        }),
      }),
    );
    newsKeys[lang] = requestKey(req);
  }

  return { city: spec.city, treatment: spec.treatment, mapsKey: requestKey(mapsReq), fetchedAt: mapsAt, hospitals, newsKeys };
}

async function main(): Promise<void> {
  const entries: SnapshotEntry[] = [];
  const combos: Record<string, SnapshotCombo> = {};
  for (const spec of [LUCKNOW, PATNA]) combos[comboId(spec.city, spec.treatment)] = buildCombo(spec, entries);

  const index: SnapshotIndex & { note: string } = {
    version: SNAPSHOT_VERSION,
    note: NOTE,
    generatedAt: at(60),
    reviewsNum: REVIEWS_NUM,
    combos,
  };

  await fs.rm(path.join(OUT, "entries"), { recursive: true, force: true });
  await fs.mkdir(path.join(OUT, "entries"), { recursive: true });
  for (const e of entries) {
    await fs.writeFile(path.join(OUT, "entries", `${e.key}.json`), JSON.stringify(e, null, 2) + "\n", "utf8");
  }
  await fs.writeFile(path.join(OUT, "index.json"), JSON.stringify(index, null, 2) + "\n", "utf8");
  console.log(`Wrote ${entries.length} sample entries and index.json to data/sample/ (${NOTE}).`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
