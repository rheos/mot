'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

// Click-to-copy affordance for ticket IDs (and other opaque references). Copies the raw value to
// the clipboard so it can be pasted to the assistant, which resolves it via mot_get_ticket(id).
// Shows a transient check on success. stopPropagation/preventDefault so it never triggers a parent
// row's click (the triage row navigates to the detail view on click).
export function CopyButton({
  value,
  title = 'Copy ID',
  className,
  iconClassName = 'h-4 w-4',
  children,
}: {
  value: string;
  title?: string;
  className?: string;
  iconClassName?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  async function copy(e: React.MouseEvent): Promise<void> {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return; // clipboard unavailable (e.g. insecure context) — fail quietly, no false success
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      onClick={(e) => void copy(e)}
      aria-label={title}
      title={copied ? 'Copied' : title}
      data-testid="copy-id"
      className={className}
    >
      {children}
      {copied ? (
        <Check aria-hidden="true" className={iconClassName} strokeWidth={2} />
      ) : (
        <Copy aria-hidden="true" className={iconClassName} strokeWidth={1.9} />
      )}
    </button>
  );
}
