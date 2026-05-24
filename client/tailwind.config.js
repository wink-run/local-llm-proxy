/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'SF Mono', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        'xs':   ['11px', { lineHeight: '1.4' }],
        'sm':   ['12px', { lineHeight: '1.45' }],
        'base': ['13px', { lineHeight: '1.5' }],
        'lg':   ['14px', { lineHeight: '1.5' }],
        'xl':   ['16px', { lineHeight: '1.4', letterSpacing: '-0.01em' }],
        '2xl':  ['20px', { lineHeight: '1.3', letterSpacing: '-0.015em' }],
        '3xl':  ['24px', { lineHeight: '1.25', letterSpacing: '-0.02em' }],
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
