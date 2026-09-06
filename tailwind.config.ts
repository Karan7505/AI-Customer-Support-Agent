import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#f4f5fb",
          100: "#e8eaf6",
          200: "#d0d4ec",
          300: "#a6addd",
          400: "#7c86cb",
          500: "#5c68c2",
          600: "#4a53b0",
          700: "#3f4694",
          800: "#363c7a",
          900: "#1c2040",
          950: "#12152c",
        },
        accent: {
          DEFAULT: "#6366f1",
          soft: "#eef0fe",
        },
        surface: {
          DEFAULT: "#0e1020",
          card: "#161932",
          line: "#262b4d",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
