import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { HostStatusBanner } from '@ui/components/HostStatusBanner';
import { useHostStatusStore } from '@ui/store/hostStatusStore';

describe('HostStatusBanner', () => {
  it('is absent while everything works', () => {
    const { container } = render(<HostStatusBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the failure code of a failing autosave and goes away once it recovers (A-11)', () => {
    render(<HostStatusBanner />);
    act(() => useHostStatusStore.getState().setAutosave({ ok: false, code: 'DSF_SAVE_DISK_FULL', message: 'ENOSPC' }));
    expect(screen.getByRole('alert').textContent).toContain('DSF_SAVE_DISK_FULL');
    expect(screen.getByRole('alert').textContent).toContain('disk is full');
    act(() => useHostStatusStore.getState().setAutosave({ ok: true }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('offers Reload when the view is out of sync (TR-INT-16)', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    try {
      render(<HostStatusBanner />);
      act(() => useHostStatusStore.getState().setOutOfSync(true));
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
