import type { Metadata, Viewport } from "next";
import SiteChrome from "@/components/SiteChrome";
import { defaultMetadata } from "@/lib/site";
import { geistMono, geistSans } from "./fonts";
import "./globals.css";

export const metadata: Metadata = defaultMetadata;

export const viewport: Viewport = {
  themeColor: "#070b14",
  colorScheme: "dark",
  // Lets the layout use the full screen on notched phones; the mobile tab bar
  // pads itself with env(safe-area-inset-bottom) so it clears the home bar.
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="flex min-h-dvh flex-col bg-bg font-sans text-ink antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-accent focus:px-4 focus:py-2 focus:font-semibold focus:text-accent-ink"
        >
          Skip to content
        </a>
        <SiteChrome />
        {/* Bottom padding on phones so content never hides behind the tab bar. */}
        <main
          id="main"
          tabIndex={-1}
          className="flex flex-1 flex-col pb-[calc(4.5rem+env(safe-area-inset-bottom))] outline-none sm:pb-0"
        >
          {children}
        </main>
      </body>
    </html>
  );
}
