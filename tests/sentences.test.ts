import { describe, expect, it } from "vitest";
import { MAX_SENTENCES, quoteFromSentences, reviewSentences, splitSentences } from "@/lib/ai/sentences";
import type { Review } from "@/types/domain";

function review(fields: Partial<Review> & { text: string }): Review {
  return { reviewId: "r1", hospitalDataId: "0x1:0x2", ...fields };
}

describe("splitSentences", () => {
  it("splits on the Devanagari danda and double danda", () => {
    expect(splitSentences("आयुष्मान कार्ड से इलाज हुआ। कोई पैसा नहीं लगा। डॉक्टर बहुत अच्छे हैं॥")).toEqual([
      "आयुष्मान कार्ड से इलाज हुआ।",
      "कोई पैसा नहीं लगा।",
      "डॉक्टर बहुत अच्छे हैं॥",
    ]);
  });

  it("splits on . ! ? and newlines, keeping punctuation runs", () => {
    expect(splitSentences("Treatment was free with the card!! Staff was rude?!\nWould not come back again.")).toEqual([
      "Treatment was free with the card!!",
      "Staff was rude?!",
      "Would not come back again.",
    ]);
  });

  it("does not split amounts, decimals or abbreviations", () => {
    expect(splitSentences("They charged Rs. 15,000 for the stent. Dr. Sharma said rating 4.5 is fake.")).toEqual([
      "They charged Rs. 15,000 for the stent.",
      "Dr. Sharma said rating 4.5 is fake.",
    ]);
  });

  it("merges fragments shorter than ~12 characters into a neighbour", () => {
    expect(splitSentences("Very bad. The hospital refused the Ayushman card. Ok.")).toEqual([
      "Very bad. The hospital refused the Ayushman card. Ok.",
    ]);
    expect(splitSentences("Fine.")).toEqual(["Fine."]);
  });

  it("returns nothing for empty text", () => {
    expect(splitSentences("   \n ")).toEqual([]);
  });
});

describe("reviewSentences", () => {
  it("strips Google markers from a snippet and numbers original then translated sentences", () => {
    const sentences = reviewSentences(
      review({
        text: "(Translated by Google) The Ayushman card was not accepted here. They asked for cash.\n\n(Original)\nयहाँ आयुष्मान कार्ड नहीं लिया गया। नकद पैसे मांगे गए।",
      }),
    );
    expect(sentences).toEqual([
      { id: 0, text: "यहाँ आयुष्मान कार्ड नहीं लिया गया।", lang: "original" },
      { id: 1, text: "नकद पैसे मांगे गए।", lang: "original" },
      { id: 2, text: "The Ayushman card was not accepted here.", lang: "translated" },
      { id: 3, text: "They asked for cash.", lang: "translated" },
    ]);
    expect(sentences.map((s) => s.text).join(" ")).not.toMatch(/translated by google|\(original\)/i);
  });

  it("uses textOriginal and textTranslated with continuous ids", () => {
    const sentences = reviewSentences(
      review({
        text: "ignored when both parts exist",
        textOriginal: "आयुष्मान कार्ड से ऑपरेशन फ्री हुआ। स्टाफ अच्छा है।",
        textTranslated: "The operation was free with the Ayushman card. The staff is good.",
      }),
    );
    expect(sentences.map((s) => s.id)).toEqual([0, 1, 2, 3]);
    expect(sentences.map((s) => s.lang)).toEqual(["original", "original", "translated", "translated"]);
    expect(sentences[0].text).toBe("आयुष्मान कार्ड से ऑपरेशन फ्री हुआ।");
    expect(sentences[2].text).toBe("The operation was free with the Ayushman card.");
  });

  it("splits review.text as original when there is no translation, removing stray markers", () => {
    const sentences = reviewSentences(review({ text: "Ayushman card accepted, no money taken. (Original)" }));
    expect(sentences).toEqual([{ id: 0, text: "Ayushman card accepted, no money taken.", lang: "original" }]);
  });

  it("NFC-normalises text", () => {
    // न + nukta composes to ऩ under NFC; e + combining acute composes to é.
    const decomposed = `${String.fromCharCode(0x928, 0x93c)} Ayushman card cafe${String.fromCharCode(0x301)} wala free ilaj.`;
    const [s] = reviewSentences(review({ text: decomposed }));
    expect(s.text).not.toBe(decomposed);
    expect(s.text).toBe(decomposed.normalize("NFC"));
    expect(s.text.startsWith(String.fromCharCode(0x929))).toBe(true);
    expect(s.text).toContain(`caf${String.fromCharCode(0xe9)}`);
  });

  it("caps the number of sentences", () => {
    const long = Array.from({ length: 60 }, (_, i) => `This is review sentence number ${i}.`).join(" ");
    const one = reviewSentences(review({ text: long }));
    expect(one).toHaveLength(MAX_SENTENCES);
    const both = reviewSentences(review({ text: long, textOriginal: long, textTranslated: long.toUpperCase() }));
    expect(both.length).toBeLessThanOrEqual(MAX_SENTENCES);
    expect(both.filter((s) => s.lang === "translated").length).toBeGreaterThan(0);
    expect(both.map((s) => s.id)).toEqual(both.map((_, i) => i));
  });
});

describe("quoteFromSentences", () => {
  const sentences = reviewSentences(
    review({
      text: "",
      textOriginal: "कार्ड होने के बाद भी दवाई के पैसे लिए। स्टाफ का व्यवहार ठीक था।",
      textTranslated: "Even with the card they took money for medicines. Staff behaviour was fine.",
    }),
  );

  it("joins cited original sentences and their translation", () => {
    expect(quoteFromSentences(sentences, [0, 2])).toEqual({
      quote: "कार्ड होने के बाद भी दवाई के पैसे लिए।",
      quoteTranslated: "Even with the card they took money for medicines.",
    });
    expect(quoteFromSentences(sentences, [1, 0]).quote).toBe("कार्ड होने के बाद भी दवाई के पैसे लिए। … स्टाफ का व्यवहार ठीक था।");
  });

  it("falls back to the translation when only translated sentences are cited, and flags it", () => {
    expect(quoteFromSentences(sentences, [3])).toEqual({ quote: "Staff behaviour was fine.", quoteIsTranslation: true });
    expect(quoteFromSentences(sentences, [0])).toEqual({ quote: "कार्ड होने के बाद भी दवाई के पैसे लिए।" });
    expect(quoteFromSentences(sentences, [])).toEqual({ quote: "" });
  });
});
