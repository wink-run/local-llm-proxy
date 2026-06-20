/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Inter', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'SF Mono', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        'xs':   ['12px', { lineHeight: '1.4' }],
        'sm':   ['13px', { lineHeight: '1.45' }],
        'base': ['14px', { lineHeight: '1.5' }],
        'lg':   ['15px', { lineHeight: '1.5' }],
        'xl':   ['17px', { lineHeight: '1.4', letterSpacing: '-0.01em' }],
        '2xl':  ['21px', { lineHeight: '1.3', letterSpacing: '-0.015em' }],
        '3xl':  ['25px', { lineHeight: '1.25', letterSpacing: '-0.02em' }],
      },
      borderRadius: {
        'sm':    '3px',
        DEFAULT: '5px',
        'md':    '6px',
        'lg':    '8px',
        'xl':    '10px',
        '2xl':   '12px',
        '3xl':   '16px',
        'full':  '9999px',
      },
    },
  },
  plugins: [],
};
