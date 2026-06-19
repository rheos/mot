'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

type ThemeMode = 'dark' | 'light';

const STORAGE_KEY = 'mot-theme';

function readStoredTheme(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'dark';
  } catch {
    return 'dark';
  }
}

function writeStoredTheme(theme: ThemeMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private browsing or locked-down storage should not block theme switching.
  }
}

function applyTheme(theme: ThemeMode, freezeTransitions: boolean): void {
  const root = document.documentElement;

  if (freezeTransitions) {
    root.dataset.anim = 'off';
    void root.offsetHeight;
  }

  root.dataset.theme = theme;

  if (freezeTransitions) {
    const releaseFreeze = (): void => {
      root.removeAttribute('data-anim');
    };
    const frame = window.requestAnimationFrame(releaseFreeze);

    window.setTimeout(() => {
      window.cancelAnimationFrame(frame);
      releaseFreeze();
    }, 120);
  }
}

export function ThemeToggle(): React.JSX.Element {
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const label = theme === 'dark' ? 'Use light theme' : 'Use dark theme';

  useEffect(() => {
    const stored = readStoredTheme();
    setTheme(stored);
    applyTheme(stored, false);
  }, []);

  function handleClick(): void {
    setTheme((current) => {
      const nextTheme: ThemeMode = current === 'dark' ? 'light' : 'dark';
      writeStoredTheme(nextTheme);
      applyTheme(nextTheme, true);
      return nextTheme;
    });
  }

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={theme === 'light'}
      title={label}
      data-testid="theme-toggle"
      onClick={handleClick}
      className="inline-flex h-9 w-9 items-center justify-center rounded-ministry-sm border border-border bg-surface-2 text-ink-2 hover:border-gold-line hover:text-gold-bright focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
    >
      {theme === 'dark' ? (
        <Sun aria-hidden="true" className="h-4 w-4" strokeWidth={1.9} />
      ) : (
        <Moon aria-hidden="true" className="h-4 w-4" strokeWidth={1.9} />
      )}
    </button>
  );
}
