// Error boundary around the r3f Canvas: a scene crash shows a fallback, the app keeps running.

import { type ErrorInfo, type ReactNode, Component } from 'react';
import { Icon } from '@ui/components/Icon';
import { errorMessage } from '@lib/errorMessage';

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
    return { hasError: true, message: errorMessage(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[ViewportErrorBoundary]', error, info);
  }

  private readonly retry = (): void => this.setState({ hasError: false, message: '' });

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
            <p className="vp-error__hint">Your document is safe. Retry, or reload the page if it keeps failing.</p>
            <button type="button" className="btn btn--ghost btn--sm" onClick={this.retry}>
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
