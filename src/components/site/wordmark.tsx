import { cn } from "@/lib/utils";

/** Card glyph + "Card Chalega?" — the mark is decorative; the text is the name. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <svg viewBox="0 0 32 32" className="size-7 shrink-0" aria-hidden="true" focusable="false">
        <rect x="2" y="6" width="28" height="20" rx="4" className="fill-primary" />
        <rect x="6" y="11" width="7" height="5" rx="1.2" className="fill-primary-foreground" opacity="0.9" />
        <path d="M6 20.5h12M6 23h8" className="stroke-primary-foreground" strokeWidth="1.6" strokeLinecap="round" opacity="0.75" />
        <path d="M22 14.5l2 2 3.5-4" fill="none" className="stroke-primary-foreground" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="whitespace-nowrap text-base sm:text-lg">Card Chalega?</span>
    </span>
  );
}
