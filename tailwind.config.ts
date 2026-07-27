import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Anthropic Sans', 'system-ui', 'sans-serif'],
        serif: ['Anthropic Serif', 'Georgia', 'serif'],
        mono: ['Anthropic Mono', 'monospace'],
      },
      colors: {
        claude: {
          orange: '#da7756',
          bg: {
            light: '#ffffff',
            dark: '#2b2a27',
          },
          text: {
            light: '#1a1915',
            dark: '#e8e4dc',
          },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
