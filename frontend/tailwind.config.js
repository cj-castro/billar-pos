/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Semantic aliases for DESIGN.md's signal-color system — state meaning
        // stays consistent even when someone reaches for a token instead of
        // picking a shade of the underlying Tailwind palette by hand.
        signal: {
          blue: '#0284c7',
          'blue-bright': '#0ea5e9',
          'blue-text': '#38bdf8',
          green: '#16a34a',
          'green-bright': '#22c55e',
          'green-text': '#4ade80',
          red: '#dc2626',
          'red-deep': '#450a0a',
          'red-text': '#f87171',
          amber: '#d97706',
          'amber-text': '#fcd34d',
          emerald: '#059669',
          violet: '#7c3aed',
        },
      },
      keyframes: {
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%': { transform: 'translateX(-8px)' },
          '40%': { transform: 'translateX(8px)' },
          '60%': { transform: 'translateX(-6px)' },
          '80%': { transform: 'translateX(6px)' },
        },
      },
      animation: {
        shake: 'shake 0.4s ease-in-out',
      },
    },
  },
  plugins: [],
}
