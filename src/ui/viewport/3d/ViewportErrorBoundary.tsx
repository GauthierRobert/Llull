/**
 * @layer ui/viewport/3d
 *
 * React error boundary wrapping the r3f Canvas.
 * Catches render errors in the 3D scene and shows a minimal fallback
 * so the rest of the app keeps running.
 */

import { Component } from 'react';
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
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#0f1117',
            color: '#e05252',
            fontFamily: 'monospace',
            fontSize: 13,
            padding: 24,
          }}
        >
          Viewport error: {this.state.message}
        </div>
      );
    }
    return this.props.children;
  }
}
