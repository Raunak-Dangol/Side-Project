import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Brand palette — red + gold (warm-toned). Semantic colors (success/
        // danger/info) are kept as Tailwind defaults and intentionally NOT
        // recolored to brand; see globals.css + component usage.
        primary: {
          DEFAULT: "#9C1816",
          dark: "#7A1210",
          light: "#E8B4B2",
          50: "#FBEEED",
        },
        gold: {
          DEFAULT: "#CBA035",
          // gold-dark is the accessible TEXT variant — base gold fails contrast
          // on light backgrounds. Use base gold only for fills/borders/icons.
          dark: "#9C7A22",
          light: "#E8D49B",
          50: "#FBF5E4",
        },
        ink: "#2A2320",
        ivory: "#F4EFE6",
        // Cinema canvas for the immersive stream view only (per the UI/UX plan
        // §2.A) — a near-black neutral so buffering/letterboxed video blends
        // into the overlay. Browse/profile/dashboard stay on the warm light theme.
        cinema: "#0B0F19",
      },
      // Named z-index vocabulary for the stream overlay (plan §3 layer
      // architecture). Replaces ad-hoc z-10/z-40/z-50 so the stacking order is
      // legible and auditable in one place.
      zIndex: {
        video: "0", // LiveKit video base
        commerce: "20", // Pinned product card, promo banner
        interactive: "30", // Bullet comments, reaction rail
        hud: "40", // TopBar, rank badge, purchase ticker, chat log
        modal: "50", // Checkout sheet + backdrop
      },
    },
  },
  plugins: [],
};

export default config;
