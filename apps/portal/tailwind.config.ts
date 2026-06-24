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
        space: {
          primary: "#6366f1",
        },
      },
      keyframes: {
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
        typingBounce: {
          "0%, 60%, 100%": { transform: "translateY(0)" },
          "30%": { transform: "translateY(-4px)" },
        },
      },
      animation: {
        blink: "blink 1s step-end infinite",
        "typing-bounce": "typingBounce 1.2s ease-in-out infinite",
        "typing-bounce-delay-1": "typingBounce 1.2s ease-in-out 0.2s infinite",
        "typing-bounce-delay-2": "typingBounce 1.2s ease-in-out 0.4s infinite",
      },
    },
  },
  plugins: [],
};

export default config;
