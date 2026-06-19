import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        'bg-deep': 'var(--bg-deep)',
        'bg-alt': 'var(--bg-alt)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        'surface-3': 'var(--surface-3)',
        border: 'var(--border)',
        hair: 'var(--hair)',
        ink: 'var(--ink)',
        'ink-2': 'var(--ink-2)',
        'ink-3': 'var(--ink-3)',
        'ink-faint': 'var(--ink-faint)',
        gold: 'var(--gold)',
        'gold-bright': 'var(--gold-bright)',
        'gold-soft': 'var(--gold-soft)',
        'gold-line': 'var(--gold-line)',
        'gold-glow': 'var(--gold-glow)',
        'on-gold': 'var(--on-gold)',
        teal: 'var(--teal)',
        'teal-bright': 'var(--teal-bright)',
        'on-teal': 'var(--on-teal)',
        amber: 'var(--amber)',
        'amber-tint': 'var(--amber-tint)',
        'amber-line': 'var(--amber-line)',
      },
      fontFamily: {
        sans: ['var(--sans)'],
        serif: ['var(--serif)'],
      },
      borderRadius: {
        ministry: 'var(--r)',
        'ministry-sm': 'var(--r-sm)',
        'ministry-xs': 'var(--r-xs)',
      },
      boxShadow: {
        ministry: 'var(--shadow)',
        'ministry-2': 'var(--shadow-2)',
        pop: 'var(--shadow-pop)',
      },
    },
  },
  plugins: [],
};

export default config;
