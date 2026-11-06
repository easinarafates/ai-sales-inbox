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
          DEFAULT: "#ff6a4d",
          dark: "#e04e33",
          light: "#ff8a70",
        },
        background: "#fff8f3",
        surface: "#ffffff",
      },
    },
  },
  plugins: [],
};
