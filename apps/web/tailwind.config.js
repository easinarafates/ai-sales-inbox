/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["'Noto Sans Bengali'", "'Hind Siliguri'", "'SolaimanLipi'", "system-ui", "-apple-system", "'Segoe UI'", "sans-serif"],
      },
      colors: {
        brand: {
          DEFAULT: "#FF5B2E",
          dark: "#E8491F",
          light: "#FFF1EA",
        },
        background: "#FFFFFF",
        surface: "#FFFFFF",
        // The warm orange tints used across the app now come from the new
        // light-orange family (#FFF1EA) so every existing orange-50/100/200
        // surface renders in the spec palette without touching each page.
        orange: {
          50: "#FFF1EA",
          100: "#FFE3D6",
          200: "#FFC7AF",
          300: "#FFA586",
          400: "#FF7A52",
          500: "#FF5B2E",
          600: "#E8491F",
          700: "#C43A17",
          800: "#9E2F14",
          900: "#7C2510",
        },
        ink: "#0F172A",
      },
    },
  },
  plugins: [],
};
