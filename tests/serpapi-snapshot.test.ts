import { describe, expect, it } from "vitest";
import { TREATMENTS } from "@/config/presets";
import { normalizeMapsResults } from "@/lib/serpapi/normalize";
import { sanitizeResponse } from "@/lib/serpapi/snapshot";

// Long enough that the substring redaction rule only hits real key strings.
const KEY = "test-key-abcdef";

describe("sanitizeResponse", () => {
  it("drops reviewer data from google_maps place_results but keeps the place", () => {
    const raw = {
      place_results: {
        title: "City Care Hospital",
        data_id: "0x1:0x2",
        type: "Hospital",
        user_reviews: { most_relevant: [{ username: "Ramesh Kumar", contributor_id: "1234", description: "Good" }] },
      },
    };
    const clean = sanitizeResponse(raw, KEY);
    expect(JSON.stringify(clean)).not.toMatch(/user_reviews|Ramesh|1234/);
    expect(clean).toMatchObject({ place_results: { title: "City Care Hospital", data_id: "0x1:0x2" } });
    expect(normalizeMapsResults(clean, TREATMENTS.general).hospitals.map((h) => h.dataId)).toEqual(["0x1:0x2"]);
  });

  it("drops review `user` and stray username/contributor_id, keeps the review text", () => {
    const clean = sanitizeResponse(
      { reviews: [{ user: { name: "Someone", contributor_id: "99" }, username: "someone", snippet: "Ayushman card worked.", review_id: "r1" }] },
      KEY,
    );
    expect(clean).toEqual({ reviews: [{ snippet: "Ayushman card worked.", review_id: "r1" }] });
  });

  it("scrubs reviewer names from hospital-reply salutations", () => {
    const clean = sanitizeResponse({ reviews: [{ response: { snippet: "Dear Sunita Devi, sorry", iso_date: "2026-01-01" } }] }, null);
    expect(JSON.stringify(clean)).not.toContain("Sunita");
    expect(clean).toEqual({ reviews: [{ response: { snippet: "Sorry", iso_date: "2026-01-01" } }] });
  });

  it("scrubs both halves of a translated reply and its extracted_snippet, keeping the marker layout", () => {
    const clean = sanitizeResponse(
      {
        reviews: [
          {
            response: {
              snippet: "(Translated by Google) Dear Rakesh ji, sorry.\n\n(Original)\nप्रिय राकेश जी, खेद है।",
              extracted_snippet: { original: "प्रिय राकेश जी, खेद है।", translated: "Dear Rakesh ji, sorry." },
            },
          },
        ],
      },
      KEY,
    );
    expect(JSON.stringify(clean)).not.toMatch(/Rakesh|राकेश/);
    expect(clean).toEqual({
      reviews: [
        {
          response: {
            snippet: "(Translated by Google) Sorry.\n\n(Original)\nखेद है।",
            extracted_snippet: { original: "खेद है।", translated: "Sorry." },
          },
        },
      ],
    });
  });

  it("redacts strings containing the API key and trims search_metadata", () => {
    const clean = sanitizeResponse(
      { search_metadata: { id: "x", status: "Success", json_endpoint: `https://serpapi.com/x?api_key=${KEY}` }, link: `https://serpapi.com/?api_key=${KEY}`, api_key: KEY },
      KEY,
    );
    expect(JSON.stringify(clean)).not.toContain(KEY);
    expect(clean).toEqual({ search_metadata: { status: "Success" }, link: "[redacted]" });
  });
});
