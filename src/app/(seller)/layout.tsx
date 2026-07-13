import Navbar from "@/components/Navbar";

/**
 * Layout for seller pages. Renders the Navbar so individual pages under this
 * group don't each import and render it themselves.
 *
 * Route group `(seller)` is organizational only — it adds no URL segment.
 * The URLs remain `/seller/apply`, `/seller/dashboard`, `/seller/orders`.
 *
 * Auth notes:
 * - Anonymous-user redirect is handled by middleware (`path.startsWith("/seller")`)
 *   and by each page's `getUser()` check. This layout does NOT enforce auth so
 *   that per-page `seller_status` logic stays intact (dashboard allows buyers,
 *   orders requires `approved`).
 */
export default function SellerLayout({
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
