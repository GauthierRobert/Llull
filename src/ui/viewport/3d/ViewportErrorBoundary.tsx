/**
 * @layer ui/viewport/3d
 *
 * React error boundary wrapping the r3f Canvas.
 * Catches render errors in the 3D scene and shows a minimal fallback
 * so the rest of the app keeps running.
 */

import { Component } from 'react';
import { Icon } from '@ui/components/Icon';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

export class ViewportErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: unknown): State {
    const message = error instanceof Error ? error.message : String(error);
    return { hasError: true, message };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[ViewportErrorBoundary]', error, info);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="vp-error" role="alert">
          <div className="vp-error__card">
            <span className="vp-error__icon">
              <Icon name="info" size={18} />
            </span>
            <h2 className="vp-error__title">The viewport hit a problem</h2>
            <p className="vp-error__message">{this.state.message}</p>
            <p className="vp-error__hint">
              Your document is safe. Reload the page to restore the view.
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
