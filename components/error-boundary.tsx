'use client';

import { Component, type ReactNode } from 'react';

// Top-level render/runtime crash boundary (house rule 6: contain a crash at a boundary
// rather than failing to a blank screen). Wraps the routed children in app/layout.tsx.
// Next.js error.tsx files catch errors per route segment; this guards the shell itself —
// anything that throws during render lands here with a Retry instead of a white page.

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  { children: ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="p-8 text-center" role="alert">
          <p className="text-red-700 text-sm font-medium">Something went wrong.</p>
          <p className="text-gray-500 text-xs mt-1">{this.state.error.message}</p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-4 text-sm underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 rounded"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
