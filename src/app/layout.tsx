import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fuel Intelligence",
  description: "Find the cheapest practical fuel nearby — price plus the drive, not just price.",
};

// The @next/next/no-page-custom-font rule is written for the Pages Router's per-page
// _document.js; this IS the App Router's root layout (renders for every route, same as
// _document.js would), so its "only loads for a single page" warning doesn't apply here.
// "Big Shoulders Display" also isn't in next/font/google's own metadata (only the non-"Display"
// variable-font family is), so next/font can't load all three fonts anyway — a plain stylesheet
// link is the straightforward choice.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;700;800&family=Public+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
