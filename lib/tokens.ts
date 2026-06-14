import type { Ministry, Severity } from './enums';

// Badge color tokens for ministry and severity. The full Tailwind class strings live here
// (not composed at runtime) so Tailwind's JIT scanner can pick them up from source — see
// the `content` globs in tailwind.config.ts, which include `lib/**`.

export const MinistryTokens: Record<
  Ministry,
  { bg: string; text: string; label: string }
> = {
  works: { bg: 'bg-slate-100', text: 'text-slate-700', label: 'Works' },
  commerce: { bg: 'bg-amber-100', text: 'text-amber-700', label: 'Commerce' },
  plenty: { bg: 'bg-green-100', text: 'text-green-700', label: 'Plenty' },
  peace: { bg: 'bg-sky-100', text: 'text-sky-700', label: 'Peace' },
  education: { bg: 'bg-indigo-100', text: 'text-indigo-700', label: 'Education' },
  flow: { bg: 'bg-violet-100', text: 'text-violet-700', label: 'Flow' },
  interior: { bg: 'bg-rose-100', text: 'text-rose-700', label: 'Interior' },
  foreign_affairs: { bg: 'bg-teal-100', text: 'text-teal-700', label: 'F.Affairs' },
};

// Severity colors are SPEC-MANDATED: critical=red, high=orange, normal=blue, low=grey.
// The bg/text pairs below clear WCAG AA contrast (dark text on a light tint).
export const SeverityTokens: Record<
  Severity,
  { bg: string; text: string; label: string }
> = {
  critical: { bg: 'bg-red-100', text: 'text-red-700', label: 'Critical' },
  high: { bg: 'bg-orange-100', text: 'text-orange-700', label: 'High' },
  normal: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'Normal' },
  low: { bg: 'bg-gray-100', text: 'text-gray-600', label: 'Low' },
};
