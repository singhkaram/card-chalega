import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { Inter, Noto_Sans_Devanagari } from "next/font/google";
import { SiteHeader } from "@/components/site/site-header";
import { SiteFooter } from "@/components/site/site-footer";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const devanagari = Noto_Sans_Devanagari({
  subsets: ["devanagari"],
  variable: "--font-devanagari",
  display: "swap",
});

const TITLE = "Card Chalega? — Will your Ayushman card work at this hospital?";
const DESCRIPTION =
  "Compare every hospital in your city on what Ayushman (PM-JAY) cardholders report in Google Maps reviews — cashless, asked to pay, or turned away — with sample sizes, a city baseline and dated quotes.";

export const metadata: Metadata = {
  title: { default: TITLE, template: "%s · Card Chalega?" },
  description: DESCRIPTION,
  applicationName: "Card Chalega?",
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: "Card Chalega?",
    type: "website",
    locale: "en_IN",
  },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8f6f2" },
    { media: "(prefers-color-scheme: dark)", color: "#111315" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${devanagari.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <a
          href="#main"
          className="sr-only z-50 rounded-md bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-3"
        >
          Skip to content
        </a>
        <SiteHeader />
        <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
