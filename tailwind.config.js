/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'bg-base': '#0A0A0B', 'glass-deep': 'rgba(255,255,255,0.03)',
        'glass-int': 'rgba(255,255,255,0.06)', 'glass-float': 'rgba(255,255,255,0.10)',
      }
    }
  },
  plugins: [],
}
