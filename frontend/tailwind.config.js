/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Semantic aliases for DESIGN.md's Monochrome Crest system — state
        // meaning stays consistent even when someone reaches for a token
        // instead of picking a shade of the underlying palette by hand.
        // No primary "interactive" hue: white/paper carries interactivity,
        // color is reserved for state only (see DESIGN.md's Color Discipline).
        signal: {
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
      fontFamily: {
        display: ['Archivo', 'system-ui', 'sans-serif'],
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
