import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useStore } from '@ui/store';
import { usePortGlyphStore } from '@ui/store/portGlyphStore';
import { PropertiesPanel } from '@ui/panels/PropertiesPanel';
import { parseDatasheet } from '@ui/panels/building/datasheetView';
import { resetStore } from '../helpers/componentEntities';
import { separatorDocument } from '../unit/plant/equipment/equipmentFixtures';
import { liveSnapshot } from '../helpers/storeTestHelpers';

function selectSeparatorBody(): void {
  const document = separatorDocument();
  useStore.getState().hydrateLiveDocument(liveSnapshot(document));
  const body = Object.keys(document.entities).find((id) => id.endsWith(':body')) ?? Object.keys(document.entities)[0];
  useStore.getState().select([body ?? '']);
}

beforeEach(() => {
  resetStore();
  usePortGlyphStore.setState({ shown: true });
});

describe('equipment data-sheet section', () => {
  it('shows the reviewRequired badge, code results and the nozzle schedule of the selected equipment', () => {
    selectSeparatorBody();
    render(<PropertiesPanel />);
    expect(screen.getByTestId('equipment-datasheet')).toBeInTheDocument();
    expect(screen.getByTestId('datasheet-review-badge')).toHaveTextContent('reviewRequired');
    expect(screen.getByTestId('datasheet-check-status')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Nozzle schedule' }).querySelectorAll('tbody tr').length).toBeGreaterThan(0);
  });

  it('toggles the port glyph overlay from the section', () => {
    selectSeparatorBody();
    render(<PropertiesPanel />);
    fireEvent.click(screen.getByTestId('ports-shown'));
    expect(usePortGlyphStore.getState().shown).toBe(false);
  });

  it('parses nothing when the query returned no sheet', () => {
    expect(parseDatasheet({ message: 'refused' })).toBeNull();
    expect(parseDatasheet(undefined)).toBeNull();
  });

  it('reads review, code results and unavailable sections defensively', () => {
    const view = parseDatasheet({
      review: { status: 'not_reviewed', reviewRequired: false, reasons: ['r1', 4], unverified: true },
      codeResults: {
        check: { status: 'fail', issues: [{ code: 'EQP_X', severity: 'fail', message: 'bad' }, 'junk'] },
        thickness: { available: false, message: 'no design data' },
      },
      nozzles: [{ mark: 'N1', service: 'feed', dn: 100, rating: '150' }, 'junk'],
    });
    expect(view).toMatchObject({
      reviewRequired: false,
      reasons: ['r1'],
      unverified: true,
      checkStatus: 'fail',
      mawpMPa: null,
      unavailable: ['Thickness: no design data'],
    });
    expect(view?.issues).toHaveLength(2);
    expect(view?.nozzles[0]).toEqual({ mark: 'N1', service: 'feed', dn: 100, rating: '150' });
    expect(parseDatasheet({ review: {}, codeResults: { check: { available: false } } })?.checkStatus).toBeNull();
  });
});
