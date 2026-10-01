/**
 * @layer ui/components
 *
 * Top-level error boundary: a render crash anywhere shows a recoverable screen
 * instead of a blank page.
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  message: string | null;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { message: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[AppErrorBoundary]', error, info);
  }

  render(): ReactNode {
    if (this.state.message === null) return this.props.children;
    return (
      <div role="alert" className="app-error">
        <div className="app-error__card">
          <strong className="app-error__title">Something went wrong</strong>
          <code className="app-error__message">{this.state.message}</code>
          <button
            type="button"
            className="app-error__reload"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
