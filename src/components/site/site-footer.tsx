import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-border bg-muted/50 print:mt-6 print:bg-transparent">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-muted-foreground sm:px-6">
        <p>
          Hospital and review data via SerpApi (Google Maps, Google Maps Reviews, Google News). AI classification by Claude.
        </p>
        <p>Built for SerpApi India Hackathon 2026. Development assisted by AI tools (Claude Code).</p>
        <p className="font-medium text-foreground">
          Reviews are self-reported and unverified. Not affiliated with NHA/PM-JAY. Not medical or legal advice.
        </p>
        <p className="no-print">
          <Link href="/methodology" className="underline underline-offset-4 hover:text-foreground">
            How the numbers are made
          </Link>
        </p>
      </div>
    </footer>
  );
}
