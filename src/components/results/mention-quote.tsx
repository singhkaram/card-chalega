import { ExternalLink, Star } from "lucide-react";
import type { ClassifiedMention } from "@/types/domain";
import { Badge } from "@/components/ui/badge";
import { WINDOW_MONTHS } from "@/lib/scoring/score";
import { ClassChip } from "./evidence-bar";
import { isExcluded } from "./evidence";
import { formatInr, formatMonthYear, langFor, reviewAge, safeExternalUrl } from "./format";

interface MentionQuoteProps {
  mention: ClassifiedMention;
  /** Older than the scoring window — shown, but not counted. */
  older?: boolean;
}

/**
 * One review excerpt, assembled by code from the cited sentences. Usually the
 * quote is the reviewer's own words, verbatim, with Google's translation below.
 * When only translated sentences were cited (`quoteIsTranslation`), it is shown
 * as Google's translation, never in quote marks as if the reviewer wrote it.
 * Hospital replies are shown in their original language, translation below.
 * Reviewer identity is never available, so none is shown.
 */
export function MentionQuote({ mention, older = false }: MentionQuoteProps) {
  const link = safeExternalUrl(mention.link);
  const age = reviewAge(mention.isoDate, mention.relativeDate);
  const quote = mention.quote.trim();
  const quoteIsTranslation = mention.quoteIsTranslation === true;
  const translated =
    !quoteIsTranslation && mention.quoteTranslated && mention.quoteTranslated.trim() !== quote
      ? mention.quoteTranslated
      : null;
  const excluded = isExcluded(mention.cls);
  const reply = mention.ownerResponse;
  const replyTranslated =
    reply?.textTranslated && reply.textTranslated.trim() !== reply.text.trim() ? reply.textTranslated : null;

  return (
    <div className="rounded-lg border border-border bg-card p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
        <ClassChip cls={mention.cls} className="text-foreground" />
        {typeof mention.rating === "number" ? (
          <span className="inline-flex items-center gap-0.5 text-foreground">
            <span aria-hidden="true">{mention.rating}</span>
            <Star className="size-3.5 fill-star text-star" aria-hidden="true" />
            <span className="sr-only">Rated {mention.rating} out of 5</span>
          </span>
        ) : null}
        {age ? <span>{age}</span> : null}
        {mention.amountInr !== null && mention.amountInr > 0 ? (
          <Badge variant="accent" className="tabular-nums">
            {formatInr(mention.amountInr)} mentioned
          </Badge>
        ) : null}
        {excluded ? <Badge variant="muted">Not counted</Badge> : older ? <Badge variant="muted">Older than {WINDOW_MONTHS} months · not counted</Badge> : null}
      </div>

      {quote === "" ? (
        <p className="mt-2 text-sm text-muted-foreground">No excerpt cited. See the full review on Google Maps.</p>
      ) : quoteIsTranslation ? (
        <>
          <p className="mt-2 break-words text-[15px] leading-relaxed">
            <span className="font-medium text-muted-foreground">Translation (Google):</span>{" "}
            <span lang="en">{quote}</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Original-language text: see the review on Google Maps.</p>
        </>
      ) : (
        <blockquote lang={langFor(quote)} className="mt-2 whitespace-pre-line break-words text-[15px] leading-relaxed">
          “{quote}”
        </blockquote>
      )}
      {translated ? (
        <p className="mt-1.5 break-words text-sm text-muted-foreground">
          <span className="font-medium">Translation (Google):</span> <span lang="en">{translated}</span>
        </p>
      ) : null}

      {reply ? (
        <div className="mt-3 border-l-2 border-primary/40 pl-3 text-sm">
          <p className="font-medium">
            Hospital replied{reply.isoDate ? <span className="font-normal text-muted-foreground"> · {formatMonthYear(reply.isoDate)}</span> : null}:
          </p>
          <p lang={langFor(reply.text)} className="mt-0.5 whitespace-pre-line break-words text-muted-foreground">
            {reply.text}
          </p>
          {replyTranslated ? (
            <p className="mt-1 break-words text-muted-foreground">
              <span className="font-medium">Translation (Google):</span> <span lang="en">{replyTranslated}</span>
            </p>
          ) : null}
        </div>
      ) : null}

      {link ? (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="print-url mt-3 inline-flex min-h-6 items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          View on Google Maps
          <ExternalLink className="size-3.5" aria-hidden="true" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      ) : null}
    </div>
  );
}
