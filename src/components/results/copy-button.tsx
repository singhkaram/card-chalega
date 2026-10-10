"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { copyText } from "./share";

interface CopyButtonProps extends Omit<ButtonProps, "onClick" | "children" | "asChild"> {
  /** Static text, or a function evaluated at click time (e.g. to include the page URL). */
  text: string | (() => string);
  label: string;
  copiedLabel?: string;
  icon?: ReactNode;
}

export function CopyButton({ text, label, copiedLabel = "Copied", icon, variant = "outline", size = "sm", ...props }: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [state]);

  async function onClick() {
    const ok = await copyText(typeof text === "function" ? text() : text);
    setState(ok ? "copied" : "failed");
  }

  return (
    <>
      <Button variant={variant} size={size} onClick={onClick} {...props}>
        {state === "copied" ? <Check aria-hidden="true" /> : (icon ?? <Copy aria-hidden="true" />)}
        {state === "copied" ? copiedLabel : state === "failed" ? "Couldn't copy" : label}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {state === "copied" ? "Copied to clipboard." : state === "failed" ? "Copy failed. Please select the text and copy it manually." : ""}
      </span>
    </>
  );
}
