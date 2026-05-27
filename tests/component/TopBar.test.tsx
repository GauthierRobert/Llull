/**
 * Component tests for <TopBar />.
 *
 * Asserts observable behavior (workflow W3, react R11):
 *   - Brand wordmark "Llull" renders.
 *   - Agent pill reflects liveStatus: shows "claude-mcp" when connected,
 *     "connecting…" when connecting, "offline" when disconnected.
 *   - "Design" tab is present and marked active.
 *   - "Render" tab is present but aria-disabled.
 *
 * Does NOT test CSS variables or visual appearance.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { TopBar } from '@ui/components/TopBar';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null, liveStatus: 'connecting' });
}

// ---------------------------------------------------------------------------
// TopBar — brand
// ---------------------------------------------------------------------------

describe('TopBar — brand', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('renders the brand wordmark "Llull"', () => {
    render(<TopBar />);
    expect(screen.getByText('Llull')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TopBar — agent pill
// ---------------------------------------------------------------------------

describe('TopBar — agent pill', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('shows "claude-mcp" text when liveStatus is connected', () => {
    useStore.setState({ liveStatus: 'connected' });
    render(<TopBar />);
    expect(screen.getByText('claude-mcp')).toBeDefined();
  });

  it('shows "connecting…" text when liveStatus is connecting', () => {
    useStore.setState({ liveStatus: 'connecting' });
    render(<TopBar />);
    expect(screen.getByText('connecting…')).toBeDefined();
  });

  it('shows "offline" text when liveStatus is disconnected', () => {
    useStore.setState({ liveStatus: 'disconnected' });
    render(<TopBar />);
    expect(screen.getByText('offline')).toBeDefined();
  });

  it('has agent-pill--connected class when connected', () => {
    useStore.setState({ liveStatus: 'connected' });
    render(<TopBar />);
    const pill = screen.getByLabelText(/mcp agent: connected/i);
    expect(pill.className).toContain('agent-pill--connected');
  });

  it('has accessible label reflecting connected status', () => {
    useStore.setState({ liveStatus: 'connected' });
    render(<TopBar />);
    expect(screen.getByLabelText('MCP agent: connected')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TopBar — tabs
// ---------------------------------------------------------------------------

describe('TopBar — tabs', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('renders a "Design" tab that is active', () => {
    render(<TopBar />);
    const designTab = screen.getByRole('button', { name: /design/i });
    expect(designTab).toBeDefined();
    expect(designTab.getAttribute('aria-pressed')).toBe('true');
  });

  it('renders a "Render" tab that is aria-disabled', () => {
    render(<TopBar />);
    const renderTab = screen.getByRole('button', { name: /render/i });
    expect(renderTab).toBeDefined();
    expect(renderTab.getAttribute('aria-disabled')).toBe('true');
  });
});
