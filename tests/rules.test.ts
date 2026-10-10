import { describe, expect, it } from "vitest";
import { TREATMENTS } from "@/config/presets";
import {
  acceptAmount,
  classifyWithRules,
  detectTreatments,
  extractRupeeAmounts,
  numbersInText,
  preClassify,
} from "@/lib/ai/rules";
import { reviewSentences } from "@/lib/ai/sentences";
import type { EvidenceClass, Hospital, Review, TreatmentId } from "@/types/domain";

const hospital: Hospital = { dataId: "0xa:0xb", name: "City Care Hospital", types: ["Hospital"], isGovernment: false, nameCollision: false };
const ayushmanHospital: Hospital = { ...hospital, dataId: "0xc:0xd", name: "Ayushman Hospital", nameCollision: true };

let seq = 0;
function review(text: string, extra: Partial<Review> = {}): Review {
  return { reviewId: `r${++seq}`, hospitalDataId: hospital.dataId, text, rating: 2, isoDate: "2026-05-01T00:00:00Z", ...extra };
}

function classify(text: string, opts: { h?: Hospital; treatment?: TreatmentId; extra?: Partial<Review> } = {}) {
  const r = review(text, opts.extra);
  const sentences = reviewSentences(r);
  return { mention: classifyWithRules(opts.h ?? hospital, r, sentences, TREATMENTS[opts.treatment ?? "general"]), sentences, review: r };
}

describe("preClassify", () => {
  it("flags a name collision when an 'Ayushman' hospital review has no scheme term", () => {
    expect(preClassify(ayushmanHospital, review("Ayushman Hospital staff is very caring and the building is clean."))).toBe("NAME_COLLISION");
    expect(preClassify(ayushmanHospital, review("आयुष्मान हॉस्पिटल के डॉक्टर अच्छे हैं।"))).toBe("NAME_COLLISION");
  });

  it("does not flag a name collision when the review has scheme context", () => {
    expect(preClassify(ayushmanHospital, review("Ayushman Hospital took my Ayushman card and the surgery was cashless."))).toBeNull();
    expect(preClassify(ayushmanHospital, review("आयुष्मान कार्ड से इलाज हुआ।"))).toBeNull();
    expect(preClassify(ayushmanHospital, review("Golden card wale patients ka ilaj free hota hai."))).toBeNull();
    expect(preClassify(ayushmanHospital, review("PMJAY yojana me sab free."))).toBeNull();
  });

  it("marks ABHA / health ID / OPD registration as NOT_PMJAY", () => {
    expect(preClassify(hospital, review("Got my ABHA card made here for OPD registration, ayushman app works well."))).toBe("NOT_PMJAY");
    expect(preClassify(hospital, review("Created Ayushman Bharat Health Account at the counter, scan and share made OPD fast."))).toBe("NOT_PMJAY");
    expect(preClassify(hospital, review("ओपीडी पर्ची के लिए आयुष्मान ऐप से हेल्थ आईडी बनवाई।"))).toBe("NOT_PMJAY");
  });

  it("keeps ABHA reviews that also talk about the scheme", () => {
    expect(preClassify(hospital, review("They asked for ABHA id but treated my father free on Ayushman card."))).toBeNull();
  });

  it("returns null for ordinary scheme reviews", () => {
    expect(preClassify(hospital, review("Ayushman card not accepted here."))).toBeNull();
    expect(preClassify(hospital, review("Golden card se free ilaj hua."))).toBeNull();
    expect(preClassify(hospital, review("Card pe operation hua lekin lens ke paise alag se liye."))).toBeNull();
    expect(preClassify(hospital, review("Ayusman card par bhi paise liye."))).toBeNull();
  });

  it("marks reviews with no Ayushman, card or scheme word as NOT_PMJAY", () => {
    expect(preClassify(hospital, review("The staff refused to admit my father at night. Dr Ayush was rude."))).toBe("NOT_PMJAY");
    expect(preClassify(hospital, review("Treatment was free and staff were helpful, thanks Dr Ayushi."))).toBe("NOT_PMJAY");
    expect(preClassify(hospital, review("Free parking available, nice clean rooms."))).toBe("NOT_PMJAY");
    // Any text variant counts: here only the translation names the card.
    expect(
      preClassify(hospital, review("", { textOriginal: "அட்டையில் இலவச சிகிச்சை கிடைத்தது.", textTranslated: "Got free treatment on the Ayushman card." })),
    ).toBeNull();
  });
});

describe("detectTreatments", () => {
  it("matches English, Hindi and Hinglish keywords", () => {
    expect(detectTreatments("Dialysis was free on the card")).toEqual(["dialysis"]);
    expect(detectTreatments("मोतियाबिंद का ऑपरेशन हुआ")).toEqual(["cataract"]);
    expect(detectTreatments("Motiyabind operation and knee replacement")).toEqual(["cataract", "knee-replacement"]);
    expect(detectTreatments("Stent dala, angioplasty free")).toEqual(["angioplasty"]);
    expect(detectTreatments("C-section delivery in the card")).toEqual(["delivery"]);
  });

  it("does not match inside other words or figures of speech", () => {
    expect(detectTreatments("They were kind, heartfelt thanks to the staff")).toEqual([]);
    expect(detectTreatments("Ayushman card accepted")).toEqual([]);
  });
});

describe("rupee amounts", () => {
  it("extracts amounts written as money", () => {
    expect(extractRupeeAmounts("They took ₹15,000 for medicines")).toEqual([15000]);
    expect(extractRupeeAmounts("Rs. 1,50,000 bill")).toEqual([150000]);
    expect(extractRupeeAmounts("paid 2000/- extra")).toEqual([2000]);
    expect(extractRupeeAmounts("15k liye")).toEqual([15000]);
    expect(extractRupeeAmounts("15 हजार रुपये लिए")).toEqual([15000]);
    expect(extractRupeeAmounts("20 hazar maange")).toEqual([20000]);
    expect(extractRupeeAmounts("2.5 lakh ka bill")).toEqual([250000]);
    expect(extractRupeeAmounts("१०००० रुपये लिए")).toEqual([10000]);
  });

  it("ignores plain numbers, phone numbers and the 5 lakh coverage limit", () => {
    expect(extractRupeeAmounts("Admitted for 3 days, call 9876543210")).toEqual([]);
    expect(extractRupeeAmounts("Card gives 5 lakh cover")).toEqual([]);
  });

  it("finds every written number for LLM amount validation", () => {
    expect([...numbersInText("paid 15,000 and then 15k more, 2 500 later")].sort((a, b) => a - b)).toEqual([2, 500, 2500, 15000]);
  });

  it("accepts an amount only if it is written in the cited text, for money classes", () => {
    expect(acceptAmount(15000, "they took 15 hazar", "CHARGED_OUTSIDE_PACKAGE_OR_UNCLEAR")).toBe(15000);
    expect(acceptAmount(5000, "they took 15000", "CHARGED_OUTSIDE_PACKAGE_OR_UNCLEAR")).toBeNull();
    expect(acceptAmount(15000, "they took 15000", "CASHLESS_OK")).toBeNull();
    expect(acceptAmount(null, "they took 15000", "REFUSED")).toBeNull();
  });

  it("reads amounts written right after 'Rs.' or 'INR.', but not the tail of a decimal or digit group", () => {
    expect(numbersInText("Unhone Rs.500 liye").has(500)).toBe(true);
    expect(acceptAmount(500, "Unhone Rs.500 liye", "CHARGED_OUTSIDE_PACKAGE_OR_UNCLEAR")).toBe(500);
    expect(acceptAmount(15000, "Rs.15,000/- maange", "CHARGED_FOR_PACKAGE_ITEMS")).toBe(15000);
    expect(acceptAmount(2000, "paid INR.2000 extra", "CHARGED_OUTSIDE_PACKAGE_OR_UNCLEAR")).toBe(2000);
    expect(extractRupeeAmounts("Unhone Rs.500 liye")).toEqual([500]);
    // Guards: "1.5 lakh" is one amount and "1,500" does not contain 500.
    expect([...numbersInText("1.5 lakh liye")]).toEqual([150000]);
    expect(acceptAmount(500, "1,500 liye", "CHARGED_OUTSIDE_PACKAGE_OR_UNCLEAR")).toBeNull();
    expect(acceptAmount(50, "paid 2.50 lakh", "CHARGED_OUTSIDE_PACKAGE_OR_UNCLEAR")).toBeNull();
  });
});

describe("classifyWithRules", () => {
  const cases: [EvidenceClass, string][] = [
    ["REFUSED", "They refused to take the Ayushman card and sent us away."],
    ["REFUSED", "Ayushman card dikhaya to unhone mana kar diya."],
    ["REFUSED", "यहाँ आयुष्मान कार्ड नहीं लिया, कहा प्राइवेट में कराओ।"],
    ["REFUSED", "Golden card accept nahi kiya hospital walon ne."],
    ["REFUSED", "Hospital did not accept the Ayushman card at all."],
    ["CHARGED_FOR_PACKAGE_ITEMS", "Despite the Ayushman card they charged Rs 5000 for medicines."],
    ["CHARGED_FOR_PACKAGE_ITEMS", "Ayushman card hone ke baad bhi dawai ke 3000 rupaye liye."],
    ["CHARGED_FOR_PACKAGE_ITEMS", "आयुष्मान कार्ड होने के बाद भी दवाई बाहर से मंगवाई।"],
    ["CHARGED_FOR_PACKAGE_ITEMS", "Card pe operation hua lekin lens ke paise alag se liye."],
    ["CHARGED_OUTSIDE_PACKAGE_OR_UNCLEAR", "Even Ayushman card holders have to pay extra money here."],
    ["CHARGED_OUTSIDE_PACKAGE_OR_UNCLEAR", "Ayushman card hai phir bhi 20 hazar liye."],
    ["CHARGED_OUTSIDE_PACKAGE_OR_UNCLEAR", "आयुष्मान कार्ड होने पर भी 10000 रुपये लिए।"],
    ["CHARGED_OUTSIDE_PACKAGE_OR_UNCLEAR", "Ayushman card holder ko pehle 10000 jama karane ko bola."],
    ["CHARGED_OUTSIDE_PACKAGE_OR_UNCLEAR", "Ayushman card me sab free bola tha lekin discharge pe 15,000 ka bill thama diya."],
    ["CASHLESS_OK", "Treatment was totally free with the Ayushman card."],
    ["CASHLESS_OK", "Ayushman card se ilaj hua, koi paisa nahi laga."],
    ["CASHLESS_OK", "आयुष्मान कार्ड से मुफ्त इलाज हुआ।"],
    ["CASHLESS_OK", "आयुष्मान कार्ड से ऑपरेशन हुआ, अस्पताल ने पैसा नहीं लिया।"],
    ["CASHLESS_OK", "My father's surgery under Ayushman, no money charged at all."],
    ["DELAY", "Ayushman approval pending for 3 days, we had to wait a lot."],
    ["DELAY", "Ayushman card ke liye bahut intezaar karna pada."],
    ["DELAY", "आयुष्मान कार्ड की मंजूरी में बहुत देरी हुई।"],
    ["ELIGIBILITY_OR_SPECIALTY_DISPUTE", "Hospital is not empanelled for cardiology under Ayushman."],
    ["ELIGIBILITY_OR_SPECIALTY_DISPUTE", "Mera Ayushman card verify nahi hua counter pe."],
    ["ELIGIBILITY_OR_SPECIALTY_DISPUTE", "Ayushman card not verified, they said name is not in the list."],
    ["ELIGIBILITY_OR_SPECIALTY_DISPUTE", "आयुष्मान कार्ड में यह बीमारी कवर नहीं है बोले।"],
    ["ELIGIBILITY_OR_SPECIALTY_DISPUTE", "They refused because this specialty is not covered under Ayushman."],
    // A specialty limit given as the reason for refusing is a dispute, not a flat refusal.
    ["ELIGIBILITY_OR_SPECIALTY_DISPUTE", "Ayushman card pe bola sirf aankh ka ilaaj hoga, general surgery ke liye mana kar diya."],
    ["ELIGIBILITY_OR_SPECIALTY_DISPUTE", "आयुष्मान कार्ड पर बोले सिर्फ आंख का इलाज होगा, सर्जरी के लिए मना कर दिया।"],
    ["ELIGIBILITY_OR_SPECIALTY_DISPUTE", "They refused the Ayushman card, said they only do eye surgeries here."],
    // A declined optional offer is not a charge; an accepted or charged one still is.
    ["CASHLESS_OK", "Cataract operation for my mother under the Ayushman card. Free, but a lens upgrade was offered for ₹6,000 which we declined."],
    ["CHARGED_FOR_PACKAGE_ITEMS", "Ayushman card, free operation but they offered a lens for ₹6,000 and we paid it."],
    ["CHARGED_FOR_PACKAGE_ITEMS", "Despite the Ayushman card they offered a premium lens and charged ₹6,000 for it."],
    ["MENTION_ONLY", "Do they accept the Ayushman card here?"],
    ["MENTION_ONLY", "Ayushman card counter is on the ground floor."],
  ];

  it.each(cases)("%s ← %s", (expected, text) => {
    const { mention, sentences } = classify(text);
    expect(mention.cls).toBe(expected);
    expect(mention.classifier).toBe("rules");
    expect(mention.sentenceIds.length).toBeGreaterThan(0);
    for (const id of mention.sentenceIds) expect(sentences.some((s) => s.id === id)).toBe(true);
    expect(mention.quote.length).toBeGreaterThan(0);
  });

  it("does not read the patient refusing (to pay) as the hospital refusing the card", () => {
    const stent = classify("Ayushman me stent ka paisa alag se manga, 40 hazaar bola. Humne mana kiya to discharge me delay kiya.");
    expect(stent.mention.cls).toBe("CHARGED_FOR_PACKAGE_ITEMS");
    expect(stent.mention.amountInr).toBe(40000);
    expect(classify("Despite the Ayushman card they charged Rs 5000 for medicines. We refused to pay and complained.").mention.cls).toBe(
      "CHARGED_FOR_PACKAGE_ITEMS",
    );
    expect(classify("आयुष्मान कार्ड होने के बाद भी दवाई बाहर से मंगवाई। हमने मना किया तो डांटा।").mention.cls).toBe("CHARGED_FOR_PACKAGE_ITEMS");
    // The hospital refusing is still a refusal.
    expect(classify("Ayushman card dikhaya to unhone mana kar diya.").mention.cls).toBe("REFUSED");
  });

  it("cites the matching sentences and builds the quote from them", () => {
    const { mention } = classify("Doctors were good and polite to everyone. But the hospital refused the Ayushman card for my mother.");
    expect(mention.cls).toBe("REFUSED");
    expect(mention.sentenceIds).toEqual([1]);
    expect(mention.quote).toBe("But the hospital refused the Ayushman card for my mother.");
  });

  it("takes the amount only from cited sentences", () => {
    const { mention } = classify("Ayushman card par bhi dawai ke 3000 rupaye liye. Parking ke 50 rs alag.");
    expect(mention.cls).toBe("CHARGED_FOR_PACKAGE_ITEMS");
    expect(mention.amountInr).toBe(3000);
    expect(classify("Paid 4500 rupees extra despite Ayushman card. Room had 2 beds.").mention.amountInr).toBe(4500);
    expect(classify("Ayushman card me sab free bola tha lekin discharge pe 15,000 ka bill thama diya.").mention.amountInr).toBe(15000);
    // Money saved is not money charged.
    const saved = classify("Ayushman card se free ilaj, 2 lakh bach gaye.").mention;
    expect(saved.cls).toBe("CASHLESS_OK");
    expect(saved.amountInr).toBeNull();
  });

  it("does not read 'free treatment but medicines charged' as cashless", () => {
    expect(classify("Ayushman card par operation free tha but medicines charged 2000.").mention.cls).toBe("CHARGED_FOR_PACKAGE_ITEMS");
    expect(classify("Ayushman card me dawai free nahi hai, paise lagte hain.").mention.cls).toBe("CHARGED_FOR_PACKAGE_ITEMS");
  });

  it("cites both languages for translated reviews", () => {
    const { mention } = classify("", {
      extra: {
        textOriginal: "आयुष्मान कार्ड से मुफ्त इलाज हुआ। स्टाफ अच्छा है।",
        textTranslated: "Free treatment was done with the Ayushman card. Staff is good.",
      },
    });
    expect(mention.cls).toBe("CASHLESS_OK");
    expect(mention.sentenceIds).toEqual([0, 2]);
    expect(mention.quote).toBe("आयुष्मान कार्ड से मुफ्त इलाज हुआ।");
    expect(mention.quoteTranslated).toBe("Free treatment was done with the Ayushman card.");
    expect(mention).not.toHaveProperty("quoteIsTranslation");
  });

  it("flags a quote built only from Google's translation", () => {
    const { mention, sentences } = classify("", {
      extra: {
        textOriginal: "ஆயுஷ்மான் அட்டையில் இலவச சிகிச்சை கிடைத்தது.",
        textTranslated: "Got free treatment with the Ayushman card.",
      },
    });
    expect(mention.cls).toBe("CASHLESS_OK");
    expect(mention.sentenceIds.every((id) => sentences[id].lang === "translated")).toBe(true);
    expect(mention).toMatchObject({ quote: "Got free treatment with the Ayushman card.", quoteIsTranslation: true });
    expect(mention).not.toHaveProperty("quoteTranslated");
  });

  it("applies the pre-rules and cites the relevant sentence", () => {
    const collision = classify("Clean rooms and quick service. Ayushman Hospital has good doctors.", { h: ayushmanHospital });
    expect(collision.mention.cls).toBe("NAME_COLLISION");
    expect(collision.mention.sentenceIds).toEqual([1]);
    const abha = classify("Very crowded on Monday mornings. Made my ABHA id for OPD registration here, ayushman app.");
    expect(abha.mention.cls).toBe("NOT_PMJAY");
    expect(abha.mention.sentenceIds).toEqual([1]);
  });

  it("sets treatmentMentioned from keywords and the selected treatment", () => {
    const text = "Dialysis was free with the Ayushman card.";
    expect(classify(text, { treatment: "general" }).mention.treatmentMentioned).toBeNull();
    expect(classify(text, { treatment: "dialysis" }).mention.treatmentMentioned).toBe(true);
    expect(classify(text, { treatment: "cataract" }).mention.treatmentMentioned).toBe(false);
  });

  it("copies review metadata", () => {
    const ownerResponse = { text: "Please contact the Ayushman desk.", isoDate: "2026-05-02T00:00:00Z" };
    const { mention, review: r } = classify("Ayushman card not accepted here, very bad.", {
      extra: { rating: 1, relativeDate: "5 months ago", link: "https://maps.example/r", ownerResponse },
    });
    expect(mention).toMatchObject({
      reviewId: r.reviewId,
      hospitalDataId: r.hospitalDataId,
      rating: 1,
      isoDate: r.isoDate,
      relativeDate: "5 months ago",
      link: "https://maps.example/r",
      ownerResponse,
    });
  });
});
