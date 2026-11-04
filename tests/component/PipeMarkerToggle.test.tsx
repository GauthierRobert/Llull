import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createEmptyDocument } from '@core/model/types';
import { DisplaySection } from '@ui/panels/review/model/DisplaySection';
import { usePipeMarkerStore } from '@ui/store/pipeMarkerStore';

beforeEach(() => usePipeMarkerStore.setState({ shown: true }));

describe('pipe marker toggle in the review Display section', () => {
  it('switches the 3D pipe content markers off and on', () => {
    render(<DisplaySection document={createEmptyDocument()} />);
    const box = screen.getByTestId('pipe-markers-shown');
    expect(box).toBeChecked();
    fireEvent.click(box);
    expect(usePipeMarkerStore.getState().shown).toBe(false);
    fireEvent.click(box);
    expect(usePipeMarkerStore.getState().shown).toBe(true);
  });
});
