import type { City, CityId, Treatment, TreatmentId } from "@/types/domain";

// City centres are hard-coded (no Locations API calls, no free-text cities):
// keeps credits predictable and inputs allowlisted.
export const CITIES: Record<CityId, City> = {
  ghaziabad: { id: "ghaziabad", name: "Ghaziabad", nameHi: "गाज़ियाबाद", state: "Uttar Pradesh", lat: 28.6692, lng: 77.4538, zoom: 13 },
  lucknow: { id: "lucknow", name: "Lucknow", nameHi: "लखनऊ", state: "Uttar Pradesh", lat: 26.8467, lng: 80.9462, zoom: 13 },
  patna: { id: "patna", name: "Patna", nameHi: "पटना", state: "Bihar", lat: 25.5941, lng: 85.1376, zoom: 13 },
  indore: { id: "indore", name: "Indore", nameHi: "इंदौर", state: "Madhya Pradesh", lat: 22.7196, lng: 75.8577, zoom: 13 },
  jaipur: { id: "jaipur", name: "Jaipur", nameHi: "जयपुर", state: "Rajasthan", lat: 26.9124, lng: 75.7873, zoom: 13 },
};

const HOSPITAL_TYPES = ["hospital", "medical center", "medical centre", "nursing home"];

export const TREATMENTS: Record<TreatmentId, Treatment> = {
  general: {
    id: "general",
    label: "Any treatment",
    labelHi: "कोई भी इलाज",
    mapsQuery: "hospital",
    allowedTypeSubstrings: HOSPITAL_TYPES,
    keywords: [],
  },
  dialysis: {
    id: "dialysis",
    label: "Dialysis",
    labelHi: "डायलिसिस",
    mapsQuery: "dialysis hospital",
    allowedTypeSubstrings: [...HOSPITAL_TYPES, "dialysis", "kidney", "nephrolog"],
    keywords: ["dialysis", "dialisis", "डायलिसिस", "kidney", "किडनी", "nephro"],
  },
  cataract: {
    id: "cataract",
    label: "Cataract surgery",
    labelHi: "मोतियाबिंद ऑपरेशन",
    mapsQuery: "eye hospital cataract",
    allowedTypeSubstrings: [...HOSPITAL_TYPES, "eye care", "eye hospital", "ophthalm"],
    keywords: ["cataract", "मोतियाबिंद", "eye", "आँख", "आंख", "lens", "लेंस"],
  },
  delivery: {
    id: "delivery",
    label: "Delivery / maternity",
    labelHi: "डिलीवरी / प्रसव",
    mapsQuery: "maternity hospital",
    allowedTypeSubstrings: [...HOSPITAL_TYPES, "maternity", "obstetric", "gynecolog", "gynaecolog"],
    keywords: ["delivery", "डिलीवरी", "प्रसव", "c-section", "caesarean", "cesarean", "सिजेरियन", "maternity", "baby", "बच्चा"],
  },
  "knee-replacement": {
    id: "knee-replacement",
    label: "Knee replacement",
    labelHi: "घुटना प्रत्यारोपण",
    mapsQuery: "orthopedic hospital knee replacement",
    allowedTypeSubstrings: [...HOSPITAL_TYPES, "orthop"],
    keywords: ["knee", "घुटना", "घुटने", "joint replacement", "orthop"],
  },
  angioplasty: {
    id: "angioplasty",
    label: "Angioplasty / heart",
    labelHi: "एंजियोप्लास्टी / हृदय",
    mapsQuery: "heart hospital angioplasty",
    allowedTypeSubstrings: [...HOSPITAL_TYPES, "heart", "cardi"],
    keywords: ["angioplasty", "एंजियोप्लास्टी", "stent", "स्टेंट", "heart", "हृदय", "दिल", "cardiac", "bypass"],
  },
};

/** Hospitals examined per run: 1 google_maps + this many google_maps_reviews calls. */
export const HOSPITALS_PER_RUN = 8;

/** Terms that indicate the PM-JAY scheme (used for name-collision rules and the rules fallback). */
export const SCHEME_TERMS = [
  "ayushman card",
  "ayushman bharat",
  "ayushmaan card",
  "pmjay",
  "pm-jay",
  "pm jay",
  "golden card",
  "gold card",
  "yojana",
  "yojna",
  "cashless",
  "5 lakh",
  "5 lac",
  "५ लाख",
  "आयुष्मान कार्ड",
  "आयुष्मान भारत",
  "गोल्डन कार्ड",
  "योजना",
  "vay vandana",
  "वय वंदना",
];

/** Official next steps shown in the rights panel. Verify before submission. */
export const RIGHTS = {
  helpline: "14555",
  grievancePortal: "https://cgrms.pmjay.gov.in/GRMS/loginnew.htm",
  hospitalFinder: "https://hospitals.pmjay.gov.in/",
  beneficiaryPortal: "https://beneficiary.nha.gov.in/",
} as const;
