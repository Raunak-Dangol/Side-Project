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
      },
    },
  },
  plugins: [],
};

export default config;
