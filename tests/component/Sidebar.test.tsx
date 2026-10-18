import { resetStore } from '../helpers/componentEntities';
import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { useLayoutStore } from '@ui/store';
import { localDispatch } from '../helpers/storeTestHelpers';
import { Sidebar } from '@ui/components/Sidebar';

const CORE_TAB_LABELS = ['Objects', 'Layers', 'Parameters', 'History', 'Materials'];

describe('Sidebar', () => {
  beforeEach(() => {
    resetStore();
    useLayoutStore.setState({ sidebarTab: 'layers', sidebarOpen: true, pinnedTabs: [] });
  });
  it('keeps the core panels on the rail and unused domain panels behind More panels', () => {
    render(<Sidebar />);
    for (const label of CORE_TAB_LABELS) {
      expect(screen.getByRole('tab', { name: new RegExp('^' + label) })).toBeDefined();
    }
    expect(screen.queryByRole('tab', { name: /^Building/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /^Analysis/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More panels' }));
    expect(screen.getByRole('button', { name: /Building/ })).toBeDefined();
  });
  it('picking a panel from More panels opens it and pins it to the rail', () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'More panels' }));
    fireEvent.click(screen.getByRole('button', { name: /Mechanisms/ }));
    expect(useLayoutStore.getState()).toMatchObject({ sidebarTab: 'mechanisms', sidebarOpen: true, pinnedTabs: ['mechanisms'] });
    expect(screen.getByRole('tab', { name: /^Mechanisms/ })).toHaveAttribute('aria-selected', 'true');
    // Still on the rail after switching away: pinned.
    fireEvent.click(screen.getByRole('tab', { name: /^Layers/ }));
    expect(screen.getByRole('tab', { name: /^Mechanisms/ })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'More panels' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unpin Mechanisms' }));
    expect(screen.queryByRole('tab', { name: /^Mechanisms/ })).toBeNull();
  });
  it('shows a domain panel on the rail once the document uses it', () => {
    render(<Sidebar />);
    expect(screen.queryByRole('tab', { name: /^Parameters/ })).toBeDefined();
    expect(screen.queryByRole('tab', { name: /^Configurations/ })).toBeNull();
    act(() => {
      localDispatch('set_parameter', { name: 'width', expression: '10' });
      localDispatch('create_configuration', { name: 'Small', parameterValues: { width: '5' } });
    });
    expect(screen.getByRole('tab', { name: /^Configurations/ })).toBeDefined();
  });
  it('prints a visible caption under every rail icon', () => {
    render(<Sidebar />);
    expect(screen.getByRole('tab', { name: /^Parameters/ })).toHaveTextContent('Params');
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.querySelector('.rail-btn__caption')?.textContent).toBeTruthy();
    }
  });
  it('shows the Layers panel by default', () => {
    render(<Sidebar />);
    expect(screen.getByRole('tab', { name: /^Layers/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toBeDefined();
    expect(screen.getByLabelText('Layer list')).toBeDefined();
  });
  it('switches panel when another tab is selected', () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('tab', { name: /^Parameters/ }));
    expect(useLayoutStore.getState().sidebarTab).toBe('parameters');
    expect(screen.getByRole('tab', { name: /^Parameters/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByLabelText('Layer list')).toBeNull();
  });
  it('collapses when the open tab is selected again', () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('tab', { name: /^Layers/ }));
    expect(useLayoutStore.getState().sidebarOpen).toBe(false);
    expect(screen.queryByRole('tabpanel')).toBeNull();
  });
  it('announces the panel item count in the tab name', () => {
    render(<Sidebar />);
    // Empty document has the default layer.
    expect(screen.getByRole('tab', { name: 'Layers, 1' })).toBeDefined();
  });
});

describe('Sidebar — keyboard', () => {
  beforeEach(() => {
    resetStore();
    useLayoutStore.setState({ sidebarTab: 'layers', sidebarOpen: true, pinnedTabs: [] });
  });
  it('only the current tab is in the Tab order (roving tabindex)', () => {
    render(<Sidebar />);
    expect(screen.getByRole('tab', { name: /^Layers/ })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: /^History/ })).toHaveAttribute('tabindex', '-1');
  });
  it('arrow keys and Home/End move focus between tabs', () => {
    render(<Sidebar />);
    const layers = screen.getByRole('tab', { name: /^Layers/ });
    layers.focus();
    fireEvent.keyDown(layers, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /^Parameters/ }));
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /^Materials/ }));
    const objects = screen.getByRole('tab', { name: /^Objects/ });
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(objects);
    fireEvent.keyDown(objects, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /^Materials/ }));
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
    expect(document.activeElement).toBe(objects);
  });
});
