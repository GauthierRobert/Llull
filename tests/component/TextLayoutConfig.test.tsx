import { describe, expect, it, vi } from 'vitest';

const configureTextBuilder = vi.hoisted(() => vi.fn());
vi.mock('troika-three-text', () => ({ configureTextBuilder }));

import { configureTextLayout } from '@ui/viewport/textFont';

describe('configureTextLayout', () => {
  it('keeps troika typesetting off its blob worker, which the page content security policy refuses', () => {
    configureTextLayout();
    expect(configureTextBuilder).toHaveBeenCalledWith({ useWorker: false });
  });
});
