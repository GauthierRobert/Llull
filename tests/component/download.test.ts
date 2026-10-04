import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadText } from '@ui/download';

describe('downloadText', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps the object URL alive while a busy browser starts the download', () => {
    vi.useFakeTimers();
    const create = vi.fn(() => 'blob:llull');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    downloadText('a,b', 'member-schedule.csv', 'text/csv');

    expect(click).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revoke).toHaveBeenCalledWith('blob:llull');
    expect(document.querySelector('a[download]')).toBeNull();
  });
});
