import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MaterialsPanel } from '@ui/panels/MaterialsPanel';
import { useStore } from '@ui/store';
import type { CadDocument } from '@core/model/types';
import { resetStore } from '../helpers/componentEntities';
import { liveSnapshot } from '../helpers/storeTestHelpers';
import { libraryFile, mmDocument, step } from '../unit/materials/support';

function show(doc: CadDocument): void {
  useStore.getState().hydrateLiveDocument(liveSnapshot(doc));
}

beforeEach(() => resetStore());

describe('Materials library list and record inspector', () => {
  it('renders no library section without libraries', () => {
    render(<MaterialsPanel />);
    expect(screen.queryByTestId('material-libraries')).toBeNull();
  });

  it('shows the library with licence and marking badges, and opens a record', () => {
    show(step(mmDocument(), 'import_material_library', { library: libraryFile({ marking: { regime: 'EAR', eccn: '1C002' } }) }));
    render(<MaterialsPanel />);
    const library = screen.getByTestId('library-synthetic-lib');
    expect(within(library).getByTestId('library-licence-synthetic-lib')).toHaveTextContent('Company proprietary');
    expect(within(library).getByTestId('library-marking-synthetic-lib')).toHaveTextContent('EAR 1C002');
    expect(screen.queryByTestId('material-inspector')).toBeNull();
    fireEvent.click(within(library).getByTestId('record-aa7075_t6'));
    const inspector = screen.getByTestId('material-inspector');
    expect(within(inspector).getByTestId('record-marking')).toHaveTextContent('EAR 1C002');
    expect(within(inspector).getByTestId('record-density')).toHaveTextContent('2810');
    expect(within(inspector).getByTestId('record-values')).toHaveTextContent('Fbru');
  });

  it('filters the property table by basis and direction', () => {
    show(step(mmDocument(), 'import_material_library', { library: libraryFile() }));
    render(<MaterialsPanel />);
    fireEvent.click(screen.getByTestId('record-aa7075_t6'));
    const rows = (): number => within(screen.getByTestId('record-values')).getAllByRole('row').length - 1;
    const all = rows();
    expect(all).toBeGreaterThanOrEqual(3);
    fireEvent.change(screen.getByTestId('record-filter-basis'), { target: { value: 'B' } });
    expect(rows()).toBe(1);
    fireEvent.change(screen.getByTestId('record-filter-direction'), { target: { value: 'LT' } });
    expect(screen.getByTestId('record-no-values')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('record-filter-basis'), { target: { value: 'all' } });
    fireEvent.change(screen.getByTestId('record-filter-direction'), { target: { value: 'all' } });
    expect(rows()).toBe(all);
  });

  it('marks company-basis values unverified and offers their provenance', () => {
    show(step(mmDocument(), 'import_material_library', { library: libraryFile() }));
    render(<MaterialsPanel />);
    fireEvent.click(screen.getByTestId('record-aa7075_t6'));
    const density = within(screen.getByTestId('record-values')).getByTestId('record-value-density');
    expect(density).toHaveTextContent('company');
    expect(within(density).getByLabelText('Source')).toBeInTheDocument();
  });
});
