import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 px-4 py-20 text-center sm:py-28">
      <p className="text-sm font-medium text-primary">404</p>
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">This page doesn&apos;t exist</h1>
      <p className="text-muted-foreground">
        The link may be old or mistyped. You can start a new check, or read how Card Chalega works.
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        <Link href="/#check" className={buttonVariants({ size: "lg" })}>
          Check hospitals
        </Link>
        <Link href="/methodology" className={buttonVariants({ size: "lg", variant: "outline" })}>
          Methodology
        </Link>
      </div>
    </div>
  );
}
