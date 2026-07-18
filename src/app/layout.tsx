import type { Metadata, Viewport } from "next";
import "./globals.css";
import "@livekit/components-styles";

export const metadata: Metadata = {
  title: "Live Shop",
  description: "Live shopping prototype — watch, chat, buy instantly.",
};

// viewportFit=cover enables env(safe-area-inset-*) on iOS so the immersive
// stream overlays can inset themselves clear of notches / home indicators.
// themeColor is light by default; dark surfaces (the stream view) override
// per-route via their own viewport export where it matters.
export const viewport: Viewport = {
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F4EFE6" },
    { media: "(prefers-color-scheme: dark)", color: "#0B0F19" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      {/* suppressHydrationWarning: browser extensions (e.g. ColorZilla's
          `cz-shortcut-listen`) inject attributes onto <body> before React
          hydrates, which Next flags as a mismatch. This is not our markup. */}
      <body suppressHydrationWarning>
        <div className="min-h-screen flex flex-col">
          <main className="flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}
