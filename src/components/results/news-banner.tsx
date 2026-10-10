"use client";

import { useId, useState } from "react";
import { ExternalLink, Newspaper } from "lucide-react";
import type { DataSource, NewsItem } from "@/types/domain";
import { Button } from "@/components/ui/button";
import { formatIst, newsDateText, safeExternalUrl } from "./format";

interface NewsBannerProps {
  news: { items: NewsItem[]; source: DataSource; fetchedAt: string } | null;
  cityName: string;
}

const INITIAL = 3;

/** Recent Google News headlines for context. Not used in any score. */
export function NewsBanner({ news, cityName }: NewsBannerProps) {
  const [expanded, setExpanded] = useState(false);
  const headingId = useId();
  const items = (news?.items ?? []).flatMap((item) => {
    const link = safeExternalUrl(item.link);
    return link ? [{ ...item, link }] : [];
  });
  if (items.length === 0) return null;
  const shown = expanded ? items : items.slice(0, INITIAL);
  const fetched = news ? formatIst(news.fetchedAt) : "";

  return (
    <section aria-labelledby={headingId} className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
      <h2 id={headingId} className="flex items-center gap-2 text-base font-semibold">
        <Newspaper className="size-4 text-muted-foreground" aria-hidden="true" />
        In the news: Ayushman card &amp; hospitals in {cityName}
      </h2>
      <ul className="mt-2 divide-y divide-border">
        {shown.map((item) => (
          <li key={item.link} className="py-2.5">
            <a
              href={item.link}
              target="_blank"
              rel="noopener noreferrer"
              lang={item.lang}
              className="print-url inline font-medium underline-offset-4 hover:underline"
            >
              {item.title}
              <ExternalLink className="ml-1 inline size-3.5 align-[-2px] text-muted-foreground" aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {[item.source, newsDateText(item)].filter(Boolean).join(" · ")}
            </p>
          </li>
        ))}
      </ul>
      {items.length > INITIAL ? (
        <Button variant="ghost" size="sm" className="-ml-2 text-primary" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show fewer headlines" : `Show ${items.length - INITIAL} more`}
        </Button>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">
        Headlines via Google News (SerpApi){fetched ? `, fetched ${fetched}` : ""}. Context only — not used in any count or label.
      </p>
    </section>
  );
}
