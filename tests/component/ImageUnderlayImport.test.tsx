import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useStore } from '@ui/store';
import { ImageUnderlayImport, MAX_UNDERLAY_DATA_URL_CHARS } from '@ui/components/ImageUnderlayImport';
import { spyDispatch } from '../helpers/storeTestHelpers';
import { pngBytes } from '../helpers/imageFixtures';

describe('ImageUnderlayImport', () => {
  it('dispatches add_image_underlay with the file as a data URL', async () => {
    const dispatch = spyDispatch();
    render(<ImageUnderlayImport />);
    const file = new File([Uint8Array.from(pngBytes(32, 16)).buffer], 'section.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Image underlay file'), { target: { files: [file] } });
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    const [name, params] = dispatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('add_image_underlay');
    expect(params['dataUrl']).toMatch(/^data:image\/png;base64,/);
    expect(params).toMatchObject({ name: 'section.png', locked: true });
  });
  it('refuses an oversized image with a status message', async () => {
    const dispatch = spyDispatch();
    render(<ImageUnderlayImport />);
    const file = new File([new Uint8Array(MAX_UNDERLAY_DATA_URL_CHARS)], 'huge.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Image underlay file'), { target: { files: [file] } });
    await waitFor(() => expect(useStore.getState().lastSummary).toMatch(/too large/i));
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('opens the file chooser from the button and ignores an empty choice', () => {
    const dispatch = spyDispatch();
    render(<ImageUnderlayImport />);
    fireEvent.click(screen.getByRole('button', { name: /image underlay/i }));
    fireEvent.change(screen.getByLabelText('Image underlay file'), { target: { files: [] } });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
