import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MentionQuote } from "@/components/results/mention-quote";
import type { ClassifiedMention } from "@/types/domain";

function mention(extra: Partial<ClassifiedMention> = {}): ClassifiedMention {
  return {
    reviewId: "r1",
    hospitalDataId: "0x1:0x2",
    cls: "REFUSED",
    sentenceIds: [0],
    quote: "कार्ड नहीं लिया।",
    amountInr: null,
    treatmentMentioned: null,
    isoDate: "2026-09-01T00:00:00Z",
    link: "https://www.google.com/maps/reviews/x",
    classifier: "llm",
    ...extra,
  };
}

const html = (m: ClassifiedMention) => renderToStaticMarkup(createElement(MentionQuote, { mention: m }));

describe("MentionQuote", () => {
  it("quotes the reviewer's words verbatim, with Google's translation below", () => {
    const out = html(mention({ quoteTranslated: "They did not take the card." }));
    expect(out).toContain("<blockquote");
    expect(out).toContain("“कार्ड नहीं लिया।”");
    expect(out).toContain("Translation (Google):");
    expect(out).toContain("They did not take the card.");
  });

  it("labels a translation-only quote as Google's translation, never as the reviewer's words", () => {
    const out = html(mention({ quote: "They did not take the card.", quoteIsTranslation: true }));
    expect(out).not.toContain("<blockquote");
    expect(out).not.toContain("“They did not take the card.”");
    expect(out).toContain("Translation (Google):");
    expect(out).toContain("Original-language text: see the review on Google Maps.");
  });

  it("shows the hospital reply in its original language with Google's translation below", () => {
    const out = html(
      mention({ ownerResponse: { text: "कृपया आयुष्मान डेस्क से संपर्क करें।", textTranslated: "Please contact the Ayushman desk." } }),
    );
    expect(out).toContain("Hospital replied");
    expect(out).toContain("कृपया आयुष्मान डेस्क से संपर्क करें।");
    expect(out).toContain("Please contact the Ayushman desk.");
    expect(out).not.toMatch(/Translated by Google|\(Original\)/);
  });

  it("does not render empty quote marks when no sentence was cited", () => {
    const out = html(mention({ quote: "" }));
    expect(out).not.toContain("“”");
    expect(out).toContain("No excerpt cited");
  });
});
