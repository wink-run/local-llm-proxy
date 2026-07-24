/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'Segoe UI', 'Inter', 'sans-serif'],
        mono: ['SF Mono', 'ui-monospace', 'JetBrains Mono', 'Fira Code', 'monospace'],
      },
      fontSize: {
        'xs':   ['11px', { lineHeight: '1.4', letterSpacing: '0.01em' }],
        'sm':   ['12px', { lineHeight: '1.45', letterSpacing: '-0.006em' }],
        'base': ['13px', { lineHeight: '1.5', letterSpacing: '-0.01em' }],
        'lg':   ['14px', { lineHeight: '1.5', letterSpacing: '-0.012em' }],
        'xl':   ['16px', { lineHeight: '1.4', letterSpacing: '-0.018em' }],
        '2xl':  ['20px', { lineHeight: '1.3', letterSpacing: '-0.022em' }],
        '3xl':  ['24px', { lineHeight: '1.25', letterSpacing: '-0.025em' }],
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
