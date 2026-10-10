"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronDown, ExternalLink, FileText, Phone, ShieldCheck } from "lucide-react";
import type { TreatmentId } from "@/types/domain";
import { RIGHTS, TREATMENTS } from "@/config/presets";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";
import { buildCallScript, callScriptText } from "./share";

function ExternalItem({ href, title, children }: { href: string; title: string; children: ReactNode }) {
  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="print-url inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
      >
        {title}
        <ExternalLink className="size-3.5" aria-hidden="true" />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
      <p className="text-sm text-muted-foreground">{children}</p>
    </li>
  );
}

/** Helpline, official portals, tips and a bilingual call-ahead script. Sticky sidebar on desktop, collapsible on phones. */
export function RightsPanel({ treatment }: { treatment: TreatmentId }) {
  const [open, setOpen] = useState(false);
  const id = useId();

  // Links to #rights (the phone helpline strip) should land on an open panel.
  useEffect(() => {
    const sync = () => {
      if (window.location.hash === "#rights") setOpen(true);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const headingId = `${id}-heading`;
  const contentId = `${id}-content`;
  const script = buildCallScript(TREATMENTS[treatment]);

  return (
    <aside
      id="rights"
      aria-labelledby={headingId}
      className="rounded-xl border border-border bg-card shadow-sm lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto"
    >
      <h2 id={headingId} className="hidden items-center gap-2 px-5 pt-5 text-base font-semibold lg:flex print:flex">
        <ShieldCheck className="size-5 text-primary" aria-hidden="true" />
        Your rights &amp; next steps
      </h2>
      <h2 className="lg:hidden print:hidden">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((v) => !v)}
          className="flex min-h-14 w-full items-center justify-between gap-3 rounded-xl px-4 text-left text-base font-semibold"
        >
          <span className="inline-flex items-center gap-2">
            <ShieldCheck className="size-5 text-primary" aria-hidden="true" />
            Your rights &amp; next steps
          </span>
          <ChevronDown className={cn("size-5 transition-transform", open && "rotate-180")} aria-hidden="true" />
        </button>
      </h2>

      <div id={contentId} data-print="show" className={cn(open ? "block" : "hidden", "px-4 pb-5 lg:block lg:px-5")}>
        <p className="mt-2 text-sm text-muted-foreground">
          PM-JAY covers eligible families for up to ₹5 lakh a year of listed hospital treatment at empanelled hospitals —
          cashless and paperless.
        </p>

        <a
          href={`tel:${RIGHTS.helpline}`}
          className="print-url mt-4 flex items-center gap-3 rounded-lg border border-border bg-secondary/60 p-3 text-secondary-foreground hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Phone className="size-5 shrink-0" aria-hidden="true" />
          <span>
            <span className="block text-lg font-semibold tabular-nums">{RIGHTS.helpline}</span>
            <span className="block text-sm">PM-JAY helpline (toll-free) — tap to call</span>
          </span>
        </a>

        <ul className="mt-4 flex flex-col gap-3">
          <ExternalItem href={RIGHTS.grievancePortal} title="File a complaint (CGRMS)">
            Official grievance portal — if you were asked to pay or turned away.
          </ExternalItem>
          <ExternalItem href={RIGHTS.hospitalFinder} title="PM-JAY hospital finder">
            Check the hospital is empanelled — and for which specialties.
          </ExternalItem>
          <ExternalItem href={RIGHTS.beneficiaryPortal} title="Beneficiary portal">
            Check your card and eligibility.
          </ExternalItem>
        </ul>

        <h3 className="mt-5 text-sm font-semibold">At the hospital</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          <li>Ask for the Ayushman Mitra desk.</li>
          <li>If you are refused, ask for the reason in writing.</li>
          <li>If you are asked to pay, keep every bill and receipt.</li>
        </ul>

        <h3 id="call-script" className="mt-5 flex items-center gap-2 text-sm font-semibold">
          <FileText className="size-4 text-muted-foreground" aria-hidden="true" />
          Call-ahead script
        </h3>
        <div className="mt-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
          <ol lang="hi" className="list-decimal space-y-1 pl-5">
            {script.hi.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
          <ol lang="en" className="mt-3 list-decimal space-y-1 border-t border-border pl-5 pt-3 text-muted-foreground">
            {script.en.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </div>
        <div className="mt-3">
          <CopyButton text={callScriptText(script)} label="Copy script" copiedLabel="Script copied" />
        </div>
      </div>
    </aside>
  );
}
