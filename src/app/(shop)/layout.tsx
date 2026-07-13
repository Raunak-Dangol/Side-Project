import Navbar from "@/components/Navbar";

/**
 * Layout for public/stream-listing pages. Renders the Navbar so individual
 * pages under this group don't each import and render it themselves.
 *
 * Route group `(shop)` is organizational only — it adds no URL segment.
 * The full-screen `/stream/[id]` route deliberately lives OUTSIDE this
 * group (no Navbar) and inherits the root layout alone.
 */
export default function ShopLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Navbar />
      {children}
    </>
  );
}
