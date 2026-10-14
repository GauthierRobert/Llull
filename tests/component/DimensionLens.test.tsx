import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useStore } from '@ui/store';
import type { FeatureStep } from '@core/model/types';
import { lensTarget, withDimension, type LensDimension } from '@ui/viewport/3d/lensDimensions';
import { LensPills } from '@ui/viewport/3d/LensPills';
import { resetOfflineStore } from '../helpers/storeTestHelpers';

const dimension = (overrides: Partial<LensDimension> = {}): LensDimension => ({
  id: 'radius',
  key: 'radius',
  label: 'r',
  value: 1,
  expression: null,
  ...overrides,
});

describe('lensTarget', () => {
  beforeEach(() => resetOfflineStore());

  it('reads the creating step of a solid and edits it through edit_step_params', () => {
    useStore.getState().dispatch('add_cylinder', { radius: 1, height: 2 });
    const { document } = useStore.getState();
    const [id] = document.order;
    const target = lensTarget(document.featureHistory, id ?? '');
    expect(target?.stepName).toBe('add_cylinder');
    expect(target?.dimensions.map((d) => [d.label, d.value])).toEqual([
      ['r', 1],
      ['h', 2],
    ]);

    const radius = target?.dimensions[0];
    if (target === null || radius === undefined) throw new Error('no lens target');
    useStore.getState().dispatch('edit_step_params', { stepId: target.stepId, params: withDimension(target, radius, 2.5) });
    const edited = useStore.getState().document.entities[id ?? ''];
    expect(edited).toMatchObject({ kind: 'cylinder', radius: 2.5, height: 2 });
  });

  it('splits a vector size into one pill per axis and replaces only that component', () => {
    useStore.getState().dispatch('add_box', { size: [2, 3, 4] });
    const { document } = useStore.getState();
    const target = lensTarget(document.featureHistory, document.order[0] ?? '');
    expect(target?.dimensions.map((d) => `${d.label}=${d.value}`)).toEqual(['x=2', 'y=3', 'z=4']);
    const y = target?.dimensions[1];
    if (target === null || y === undefined) throw new Error('no lens target');
    expect(withDimension(target, y, 5)).toMatchObject({ size: [2, 5, 4] });
  });

  it('marks =expression params as driven and skips suppressed or unrelated steps', () => {
    const history: FeatureStep[] = [
      { id: 'step-1', name: 'add_box', params: { size: [1, 1, 1] }, affected: ['box-1.1'], suppressed: true },
      { id: 'step-2', name: 'move_entities', params: { ids: ['cyl-3.1'], delta: [1, 0, 0] }, affected: ['cyl-3.1'] },
      { id: 'step-3', name: 'add_cylinder', params: { radius: '=r', height: 2 }, affected: ['cyl-3.1'] },
    ];
    expect(lensTarget(history, 'box-1.1')).toBeNull();
    const target = lensTarget(history, 'cyl-3.1');
    expect(target?.stepId).toBe('step-3');
    expect(target?.dimensions[0]).toMatchObject({ key: 'radius', value: null, expression: '=r' });
    expect(lensTarget(history, 'nothing')).toBeNull();
  });
});

describe('LensPills', () => {
  const renderPills = (dimensions: LensDimension[], onCommit = vi.fn()): ReturnType<typeof vi.fn> => {
    render(<LensPills name="Boss" kind="cylinder" unit="mm" dimensions={dimensions} refusal={null} onCommit={onCommit} />);
    return onCommit;
  };

  it('retypes a dimension and commits it on Enter', () => {
    const onCommit = renderPills([dimension()]);
    expect(screen.getByRole('group', { name: 'Dimensions of Boss' })).toHaveTextContent('cylinder');
    fireEvent.click(screen.getByRole('button', { name: 'Edit radius: 1 mm' }));
    const input = screen.getByRole('textbox', { name: 'radius' });
    fireEvent.change(input, { target: { value: '2.5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ key: 'radius' }), 2.5);
    expect(screen.getByRole('button', { name: /Edit radius/ })).toBeInTheDocument();
  });

  it('Escape cancels, and unchanged, non-positive or non-numeric values are not committed', () => {
    const onCommit = renderPills([dimension()]);
    for (const text of ['abc', '-2', '1']) {
      fireEvent.click(screen.getByRole('button', { name: /Edit radius/ }));
      const input = screen.getByRole('textbox', { name: 'radius' });
      fireEvent.change(input, { target: { value: text } });
      fireEvent.keyDown(input, { key: 'Enter' });
    }
    fireEvent.click(screen.getByRole('button', { name: /Edit radius/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'radius' }), { target: { value: '9' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'radius' }), { key: 'Escape' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('shows an expression-driven dimension as read-only, and a refusal as an alert', () => {
    render(
      <LensPills
        name="Boss"
        kind="cylinder"
        unit="mm"
        dimensions={[dimension({ value: null, expression: '=boss_r' })]}
        refusal="edit_step_params: refused"
        onCommit={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('radius: =boss_r')).toHaveTextContent('ƒ');
    expect(screen.queryByRole('button', { name: /Edit radius/ })).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('refused');
  });
});
