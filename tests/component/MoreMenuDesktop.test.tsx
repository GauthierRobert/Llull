import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MoreMenu } from '@ui/components/MoreMenu';

afterEach(() => {
  delete (window as unknown as { llull?: unknown }).llull;
});

describe('MoreMenu file actions', () => {
  it('offers New / Open / Save outside the desktop app', () => {
    render(<MoreMenu />);
    expect(screen.queryByRole('button', { name: 'New project', hidden: true })).not.toBeNull();
  });

  it('leaves New / Open / Save to the native File menu in the desktop app (it owns the file path and lock)', () => {
    (window as unknown as { llull: unknown }).llull = { exportThreeMf: () => Promise.resolve({}) };
    render(<MoreMenu />);
    expect(screen.queryByRole('button', { name: 'New project', hidden: true })).toBeNull();
  });
});
