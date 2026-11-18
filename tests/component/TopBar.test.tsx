import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useLayoutStore, useStore, useThemeStore, useToolStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { TopBar } from '@ui/components/TopBar';

// Helpers

function resetStore(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null, liveStatus: 'connecting' });
}

// TopBar — brand

describe('TopBar — brand', () => {
  beforeEach(() => {
    resetStore();
  });
  it('renders the brand wordmark "Llull"', () => {
    render(<TopBar />);
    expect(screen.getByText('Llull')).toBeDefined();
  });
  it('shows the logo from the favicon', () => {
    const { container } = render(<TopBar />);
    expect(container.querySelector('.brand-mark img')).toHaveAttribute('src', '/favicon.svg');
  });
});

// TopBar — command palette trigger

describe('TopBar — More menu', () => {
  beforeEach(() => {
    resetStore();
  });
  it('keeps file, export and view actions out of sight until More is opened, and closes on Escape', () => {
    render(<TopBar />);
    expect(screen.queryByRole('button', { name: /open project/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('group', { name: 'More actions' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: /open project/i })).toBeNull();
  });
  it('has no command palette trigger (it lives in the command bar)', () => {
    render(<TopBar />);
    expect(screen.queryByRole('button', { name: /^Search or run a command/ })).toBeNull();
  });
});

// TopBar — theme toggle

describe('TopBar — theme toggle', () => {
  beforeEach(() => {
    resetStore();
  });
  it('flips the theme from dark to light', () => {
    useThemeStore.setState({ theme: 'dark' });
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: /switch to light theme/i }));
    expect(useThemeStore.getState().theme).toBe('light');
  });
  it('flips the theme from light to dark', () => {
    useThemeStore.setState({ theme: 'light' });
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: /switch to dark theme/i }));
    expect(useThemeStore.getState().theme).toBe('dark');
  });
});

// TopBar — dock toggles + actions

describe('TopBar — dock toggles and actions', () => {
  beforeEach(() => {
    resetStore();
    useLayoutStore.setState({ sidebarOpen: true, inspectorOpen: true });
  });
  it('hides and shows the browser panel', () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide browser panel' }));
    expect(useLayoutStore.getState().sidebarOpen).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Show browser panel' }));
    expect(useLayoutStore.getState().sidebarOpen).toBe(true);
  });
  it('hides and shows the properties panel', () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide properties panel' }));
    expect(useLayoutStore.getState().inspectorOpen).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Show properties panel' }));
    expect(useLayoutStore.getState().inspectorOpen).toBe(true);
  });
  it('exposes Open / Save in the More menu', () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('button', { name: /open project/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /save project/i })).toBeDefined();
  });
});

describe('TopBar — view switch and help', () => {
  beforeEach(() => {
    resetStore();
    useToolStore.setState({ viewMode: '3d', drawTool: 'none', modifyTool: 'none', shortcutsOpen: false });
  });
  it('the 3D / 2D switch is always visible and sets the view mode', () => {
    render(<TopBar />);
    expect(screen.getByRole('group', { name: 'View mode' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3D' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '2D' }));
    expect(useToolStore.getState().viewMode).toBe('2d');
    expect(screen.getByRole('button', { name: '2D' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    expect(useToolStore.getState().viewMode).toBe('3d');
  });
  it('Shortcuts opens the shortcut sheet', () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Shortcuts' }));
    expect(useToolStore.getState().shortcutsOpen).toBe(true);
  });
});
