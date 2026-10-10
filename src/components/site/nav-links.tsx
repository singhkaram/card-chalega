"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/#check", match: (p: string) => p === "/" || p.startsWith("/check"), label: "Check" },
  { href: "/methodology", match: (p: string) => p.startsWith("/methodology"), label: "Methodology" },
];

export function NavLinks() {
  const pathname = usePathname() ?? "/";
  return (
    <ul className="flex items-center gap-1">
      {LINKS.map((l) => {
        const active = l.match(pathname);
        return (
          <li key={l.href}>
            <Link
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex h-10 items-center rounded-md px-2 text-sm font-medium transition-colors hover:bg-muted sm:px-3",
                active ? "text-foreground underline decoration-primary decoration-2 underline-offset-[6px]" : "text-muted-foreground",
              )}
            >
              {l.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
