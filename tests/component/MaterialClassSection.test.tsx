/** VIS-M8f: the Material classes section only dispatches commands and shows the command's refusal. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MaterialClassSection } from '@ui/panels/review/model/MaterialClassSection';
import { useStore } from '@ui/store';
import { resetStore } from '../helpers/componentEntities';
import { localDispatch } from '../helpers/storeTestHelpers';

type Dispatch = ReturnType<typeof useStore.getState>['dispatch'];

/** A dispatch that runs the real command locally and reports its outcome like the store does. */
const spy = vi.fn<Dispatch>((name, params, options) => {
  const before = useStore.getState().document;
  const result = localDispatch(name, params);
  options?.onResult?.({ summary: result.summary, changed: result.document !== before });
});

function setup(): string {
  const { affected } = localDispatch('add_box', { size: [1, 1, 1] });
  const id = affected[0] ?? '';
  useStore.setState({ dispatch: spy, document: { ...useStore.getState().document, selection: [id] } });
  return id;
}

const current = (): React.ReactElement => <MaterialClassSection document={useStore.getState().document} />;

describe('MaterialClassSection', () => {
  beforeEach(() => {
    resetStore();
    spy.mockClear();
  });

  it('lists the ten defaults', () => {
    setup();
    render(current());
    expect(screen.getByLabelText('Material classes').querySelectorAll('li')).toHaveLength(10);
    expect(screen.getByTestId('material-class-stainless_steel')).toHaveTextContent('M 0.9');
  });

  it('assigns a class to the selection and clears it, through assign_material_class only', () => {
    const id = setup();
    render(current());
    fireEvent.click(screen.getByLabelText('Assign Stainless steel to the selection'));
    expect(spy).toHaveBeenCalledWith('assign_material_class', { classId: 'stainless_steel', entityIds: [id] }, expect.anything());
    expect(useStore.getState().document.display?.materialClassOf).toEqual({ [id]: 'stainless_steel' });
    fireEvent.click(screen.getByText('Clear class of selection'));
    expect(spy).toHaveBeenLastCalledWith('assign_material_class', { classId: null, entityIds: [id] }, expect.anything());
    expect(useStore.getState().document.display?.materialClassOf).toBeUndefined();
  });

  it('disables Assign without a selection', () => {
    setup();
    useStore.setState({ document: { ...useStore.getState().document, selection: [] } });
    render(current());
    expect(screen.getByLabelText('Assign Concrete to the selection')).toBeDisabled();
  });

  it('defines a class from the form (colour, metalness, roughness, name)', () => {
    setup();
    render(current());
    fireEvent.change(screen.getByLabelText('Class id'), { target: { value: 'painted_rail' } });
    fireEvent.change(screen.getByLabelText('Class name'), { target: { value: 'Painted rail' } });
    fireEvent.change(screen.getByLabelText('Metalness'), { target: { value: '0.2' } });
    fireEvent.change(screen.getByLabelText('Roughness'), { target: { value: '0.7' } });
    fireEvent.click(screen.getByText('Save class'));
    expect(spy).toHaveBeenCalledWith(
      'define_material_class',
      { id: 'painted_rail', name: 'Painted rail', colour: '#8f999f', metalness: 0.2, roughness: 0.7 },
      expect.anything(),
    );
    expect(useStore.getState().document.display?.materialClasses?.['painted_rail']?.roughness).toBe(0.7);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the refusal of an invalid class and of deleting a class still in use', () => {
    setup();
    const { rerender } = render(current());
    fireEvent.change(screen.getByLabelText('Class id'), { target: { value: 'Bad Id' } });
    fireEvent.click(screen.getByText('Save class'));
    expect(screen.getByRole('alert')).toHaveTextContent('VIS_MATERIAL_CLASS_INVALID');

    fireEvent.change(screen.getByLabelText('Class id'), { target: { value: 'rail' } });
    fireEvent.click(screen.getByText('Save class'));
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(current());
    fireEvent.click(screen.getByLabelText('Assign rail to the selection'));
    rerender(current());
    expect(screen.getByTestId('material-class-rail')).toHaveTextContent('1 assigned');
    fireEvent.click(screen.getByLabelText('Delete rail'));
    expect(screen.getByRole('alert')).toHaveTextContent('VIS_MATERIAL_CLASS_IN_USE');
    expect(useStore.getState().document.display?.materialClasses?.['rail']).toBeDefined();
  });

  it('edits a default (prefilled), and offers Delete only for a document class', () => {
    setup();
    render(current());
    expect(screen.queryByLabelText('Delete Concrete')).toBeNull();
    fireEvent.click(screen.getByLabelText('Edit Concrete'));
    expect(screen.getByLabelText('Class id')).toHaveValue('concrete');
    expect(screen.getByLabelText('Roughness')).toHaveValue(0.9);
    fireEvent.change(screen.getByLabelText('Roughness'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByText('Save class'));
    expect(useStore.getState().document.display?.materialClasses?.['concrete']?.roughness).toBe(0.5);
  });
});
