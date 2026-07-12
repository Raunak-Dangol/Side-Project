"use client";

interface PromoBannerProps {
  text: string | null;
  link: string | null;
}

/**
 * Thin full-width promo strip sitting just above BottomActionBar. Renders the
 * stream's `promo_banner_text`; hidden entirely when the text is null/empty.
 *
 * If `promo_banner_link` is set, the strip is tappable and opens the link in a
 * NEW TAB via window.open — never an in-app navigation, which would interrupt
 * the stream the viewer is watching.
 */
export default function PromoBanner({ text, link }: PromoBannerProps) {
  if (!text || !text.trim()) return null;

  const open = () => {
    if (link) window.open(link, "_blank", "noopener,noreferrer");
  };

  const interactive = Boolean(link);

  return (
    <div className="absolute bottom-[112px] left-0 right-0 z-10 px-3">
      <div
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        onClick={open}
        onKeyDown={
          interactive
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  open();
                }
              }
            : undefined
        }
        className={[
          "flex items-center justify-center gap-1.5 rounded-md bg-gold-dark/90 px-3 py-1.5 text-center text-[11px] font-medium text-ivory backdrop-blur-sm",
          interactive
            ? "cursor-pointer transition hover:bg-gold-dark"
            : "",
        ].join(" ")}
      >
        <span aria-hidden>📣</span>
        <span className="truncate">{text}</span>
      </div>
    </div>
  );
}
