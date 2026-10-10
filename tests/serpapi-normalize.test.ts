import { describe, expect, it } from "vitest";
import { TREATMENTS } from "@/config/presets";
import { isEmptyResultError } from "@/lib/serpapi/client";
import { newsDateToIso, normalizeMapsResults, normalizeNews, normalizeReviews } from "@/lib/serpapi/normalize";
import { requestKey, reviewsRequest } from "@/lib/serpapi/params";
import { stripReplySalutation } from "@/lib/serpapi/reply";

function govt(title: string, types: string[]): boolean | undefined {
  const { hospitals } = normalizeMapsResults({ local_results: [{ title, data_id: "0x1:0x2", types }] }, TREATMENTS.general);
  return hospitals[0]?.isGovernment;
}

describe("normalizeMapsResults: Govt badge", () => {
  it("does not treat private '… Medical College' hospitals as government", () => {
    expect(govt("Index Medical College Hospital & Research Centre", ["Hospital"])).toBe(false);
    expect(govt("Era's Lucknow Medical College & Hospital", ["Hospital"])).toBe(false);
    expect(govt("Santosh Medical College & Hospital", ["Private hospital"])).toBe(false);
    expect(govt("Jilani Nursing Home", ["Nursing home"])).toBe(false);
  });

  it("keeps government signals: Maps type, 'Government' in the name, curated preset colleges", () => {
    expect(govt("Sample Medical College Hospital", ["Government hospital"])).toBe(true);
    expect(govt("Government Medical College Hospital", ["Hospital"])).toBe(true);
    expect(govt("Patna Medical College and Hospital", ["Hospital"])).toBe(true);
    expect(govt("SMS Hospital", ["Hospital"])).toBe(true);
    expect(govt("Zila Hospital Ghaziabad", ["Hospital"])).toBe(true);
  });

  it("lets Google's 'Private hospital' type win over the name", () => {
    expect(govt("Govt. Approved Care Hospital", ["Private hospital"])).toBe(false);
  });
});

function reply(response: Record<string, unknown>) {
  const [review] = normalizeReviews({ reviews: [{ review_id: "r1", snippet: "Ayushman card accepted.", response }] }, "0x1:0x2");
  return review.ownerResponse as ({ text: string; textTranslated?: string; isoDate?: string } | undefined);
}

describe("owner replies", () => {
  it.each([
    ["Dear Sunita Devi, sorry for the inconvenience.", "Sorry for the inconvenience."],
    ["Dear Mr. Rakesh Kumar ji, we regret your experience.", "We regret your experience."],
    ["Dear R. K. Sharma, thank you.", "Thank you."],
    ["Hi Priya! Thanks for the feedback.", "Thanks for the feedback."],
    ["Hello Rahul ji. Please visit the Ayushman desk.", "Please visit the Ayushman desk."],
    ["प्रिय राकेश जी, असुविधा के लिए खेद है।", "असुविधा के लिए खेद है।"],
    ["नमस्ते सुनीता जी। धन्यवाद", "धन्यवाद"],
    ["Namaste Sunita ji 🙏 Thank you.", "Thank you."],
  ])("removes the salutation (and the reviewer's name) from %j", (input, expected) => {
    expect(stripReplySalutation(input)).toBe(expected);
    expect(reply({ snippet: input })?.text).toBe(expected);
  });

  it.each([
    "Thank you for your feedback.",
    "Highly appreciated, thanks",
    "Dearest patients, thank you.",
    "धन्यवाद! हम आपके पिताजी के अच्छे स्वास्थ्य की कामना करते हैं।",
  ])("leaves %j unchanged", (input) => {
    expect(stripReplySalutation(input)).toBe(input);
    expect(reply({ snippet: input })?.text).toBe(input);
  });

  it("drops a reply that is only a salutation", () => {
    expect(reply({ snippet: "Dear Rakesh ji," })).toBeUndefined();
  });

  const translatedSnippet =
    "(Translated by Google) Dear Rakesh ji, sorry for the inconvenience.\n\n(Original)\nप्रिय राकेश जी, असुविधा के लिए खेद है।";

  it("splits Google's translation layout: original first, translation separate, no markers or names", () => {
    const r = reply({ snippet: translatedSnippet, iso_date: "2026-05-02T00:00:00Z" });
    expect(r).toEqual({ text: "असुविधा के लिए खेद है।", textTranslated: "Sorry for the inconvenience.", isoDate: "2026-05-02T00:00:00Z" });
    expect(JSON.stringify(r)).not.toMatch(/Translated by Google|\(Original\)|Rakesh|राकेश/);
  });

  it("prefers extracted_snippet when present", () => {
    const r = reply({ snippet: translatedSnippet, extracted_snippet: { original: "प्रिय राकेश जी, खेद है।", translated: "Dear Rakesh ji, we are sorry." } });
    expect(r?.text).toBe("खेद है।");
    expect(r?.textTranslated).toBe("We are sorry.");
  });

  it("passes a plain English reply through unchanged", () => {
    expect(reply({ snippet: "Stents are covered under the PM-JAY package." })).toEqual({ text: "Stents are covered under the PM-JAY package.", isoDate: undefined });
  });
});

describe("normalizeNews", () => {
  it("parses SerpApi's US-style date string as UTC and drops the raw text", () => {
    expect(newsDateToIso("10/02/2026, 07:00 AM, +0000 UTC")).toBe("2026-10-02T07:00:00.000Z");
    expect(newsDateToIso("12/31/2025, 12:30 PM, +0000 UTC")).toBe("2025-12-31T12:30:00.000Z");
    expect(newsDateToIso("01/05/2026, 12:15 AM, +0000 UTC")).toBe("2026-01-05T00:15:00.000Z");
    expect(newsDateToIso("02/31/2026, 07:00 AM, +0000 UTC")).toBeUndefined();
    expect(newsDateToIso("3 hours ago")).toBeUndefined();

    const [item] = normalizeNews({ news_results: [{ title: "A", link: "https://n/a", date: "10/02/2026, 07:00 AM, +0000 UTC" }] }, "en");
    expect(item.isoDate).toBe("2026-10-02T07:00:00.000Z");
    expect(item.dateText).toBeUndefined();
  });

  it("prefers iso_date and keeps unparseable date text", () => {
    const items = normalizeNews(
      {
        news_results: [
          { title: "Relative", link: "https://n/rel", date: "3 hours ago" },
          { title: "Iso", link: "https://n/iso", iso_date: "2026-09-01T00:00:00Z", date: "10/02/2026, 07:00 AM, +0000 UTC" },
        ],
      },
      "en",
    );
    expect(items.find((i) => i.title === "Iso")).toMatchObject({ isoDate: "2026-09-01T00:00:00Z", dateText: undefined });
    expect(items.find((i) => i.title === "Relative")).toMatchObject({ isoDate: undefined, dateText: "3 hours ago" });
  });

  it("includes a cluster's lead story (highlight), dedupes links, sorts newest first with undated last", () => {
    const items = normalizeNews(
      {
        news_results: [
          { title: "Undated", link: "https://n/u" },
          { title: "Old", link: "https://n/old", date: "01/10/2025, 09:00 AM, +0000 UTC" },
          {
            highlight: { title: "Lead", link: "https://n/lead", date: "09/30/2026, 10:00 AM, +0000 UTC" },
            stories: [
              { title: "Lead again", link: "https://n/lead" },
              { title: "Mid", link: "https://n/mid", date: "06/15/2026, 08:00 AM, +0000 UTC" },
            ],
          },
        ],
      },
      "hi",
    );
    expect(items.map((i) => i.title)).toEqual(["Lead", "Mid", "Old", "Undated"]);
    expect(normalizeNews({ news_results: items.map((i) => ({ ...i, iso_date: i.isoDate })) }, "hi", 2).map((i) => i.title)).toEqual(["Lead", "Mid"]);
  });
});

describe("reviewsRequest", () => {
  it("asks for newest-first reviews unless a sort is given", () => {
    expect(reviewsRequest("0x1:0x2").params.sort_by).toBe("newestFirst");
    const relevant = reviewsRequest("0x1:0x2", { sortBy: "qualityScore" });
    expect(relevant.params.sort_by).toBe("qualityScore");
    expect(requestKey(relevant)).not.toBe(requestKey(reviewsRequest("0x1:0x2")));
  });
});

describe("isEmptyResultError", () => {
  it("treats SerpApi's 'no reviews' wording as an empty result", () => {
    expect(isEmptyResultError("Google hasn't returned any reviews for this place.")).toBe(true);
    expect(isEmptyResultError("Google hasn't returned any results for this query.")).toBe(true);
    expect(isEmptyResultError("Invalid API key.")).toBe(false);
  });
});
