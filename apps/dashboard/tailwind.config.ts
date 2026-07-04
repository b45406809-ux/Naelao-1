import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Phase D reskin: retargeted from the original sky-blue scale onto the launchpad-6
        // mockup's accent (packages/ui/src/tokens.css's --accent #5b52f0) so every existing
        // bg-brand-*/text-brand-*/border-brand-*/ring-brand-* utility across the app picks up
        // the new design language without per-page markup rewrites.
        brand: {
          50: "#f1f0fe",
          100: "#e4e2fd",
          200: "#cac6fb",
          300: "#a29bf7",
          400: "#8177f4",
          500: "#5b52f0",
          600: "#4a3fd1",
          700: "#3c33a8",
          800: "#2f2985",
          900: "#221f61",
        },
      },
    },
  },
  plugins: [],
};

export default config;
