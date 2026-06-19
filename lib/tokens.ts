import type { Ministry, Severity } from './enums';

// Badge color tokens for ministry and severity. The full Tailwind class strings live here
// (not composed at runtime) so Tailwind's JIT scanner can pick them up from source — see
// the `content` globs in tailwind.config.ts, which include `lib/**`.

type MinistryToken = {
  bg: string;
  text: string;
  label: string;
  short: string;
  icon: MinistryIconKey;
  hue: string;
};

type MinistryIconKey =
  | 'Hammer'
  | 'Banknote'
  | 'PiggyBank'
  | 'ShieldCheck'
  | 'GraduationCap'
  | 'Waves'
  | 'House'
  | 'Globe';

type SeverityToken = {
  bg: string;
  text: string;
  label: string;
  color: string;
  bar: string;
  rank: number;
};

export const MinistryTokens: Record<Ministry, MinistryToken> = {
  works: {
    bg: 'bg-slate-100',
    text: 'text-slate-700',
    label: 'Works',
    short: 'Works',
    icon: 'Hammer',
    hue: '#9fb1c6',
  },
  commerce: {
    bg: 'bg-amber-100',
    text: 'text-amber-700',
    label: 'Commerce',
    short: 'Commerce',
    icon: 'Banknote',
    hue: '#e0b35e',
  },
  plenty: {
    bg: 'bg-green-100',
    text: 'text-green-700',
    label: 'Plenty',
    short: 'Plenty',
    icon: 'PiggyBank',
    hue: '#66c08c',
  },
  peace: {
    bg: 'bg-sky-100',
    text: 'text-sky-700',
    label: 'Peace',
    short: 'Peace',
    icon: 'ShieldCheck',
    hue: '#5fb6e6',
  },
  education: {
    bg: 'bg-indigo-100',
    text: 'text-indigo-700',
    label: 'Education',
    short: 'Education',
    icon: 'GraduationCap',
    hue: '#8f9cf2',
  },
  flow: {
    bg: 'bg-violet-100',
    text: 'text-violet-700',
    label: 'Flow',
    short: 'Flow',
    icon: 'Waves',
    hue: '#b489e8',
  },
  interior: {
    bg: 'bg-rose-100',
    text: 'text-rose-700',
    label: 'Interior',
    short: 'Interior',
    icon: 'House',
    hue: '#e68ca6',
  },
  foreign_affairs: {
    bg: 'bg-teal-100',
    text: 'text-teal-700',
    label: 'F.Affairs',
    short: 'F. Affairs',
    icon: 'Globe',
    hue: '#4fc3c9',
  },
};

// Severity colors are SPEC-MANDATED: critical=red, high=orange, normal=blue, low=grey.
// The bg/text pairs below clear WCAG AA contrast (dark text on a light tint).
export const SeverityTokens: Record<Severity, SeverityToken> = {
  critical: {
    bg: 'bg-red-100',
    text: 'text-red-700',
    label: 'Critical',
    color: '#ea6f7f',
    bar: '#e0475c',
    rank: 4,
  },
  high: {
    bg: 'bg-orange-100',
    text: 'text-orange-700',
    label: 'High',
    color: '#e2a45f',
    bar: '#dd8a3e',
    rank: 3,
  },
  normal: {
    bg: 'bg-blue-100',
    text: 'text-blue-700',
    label: 'Normal',
    color: '#62a9da',
    bar: '#4f93c8',
    rank: 2,
  },
  low: {
    bg: 'bg-gray-100',
    text: 'text-gray-600',
    label: 'Low',
    color: '#8a93a3',
    bar: '#6f7889',
    rank: 1,
  },
};
