import { resetStore } from '../helpers/componentEntities';
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useStore } from '@ui/store';
import { useFocusStore } from '@ui/store/focusStore';
import { LayersPanel } from '@ui/panels/LayersPanel';
import { MaterialsPanel } from '@ui/panels/MaterialsPanel';
import { ParametersPanel } from '@ui/panels/ParametersPanel';
import { FeatureHistoryPanel } from '@ui/panels/FeatureHistoryPanel';
import { ConfigurationsPanel } from '@ui/panels/ConfigurationsPanel';
import { ObjectsPanel } from '@ui/panels/ObjectsPanel';
import { PropertiesPanel } from '@ui/panels/PropertiesPanel';
import { localDispatch } from '../helpers/storeTestHelpers';

function addBox(params: Record<string, unknown> = { size: [10, 20, 30] }): string {
  return localDispatch('add_box', params).affected[0]!;
}

function addDrivenBox(): string {
  const result = localDispatch('insert_step', { name: 'add_box', params: { size: ['=w', 5, 5] } });
  return Object.keys(result.document.entities).at(-1)!;
}

function focus(): ReturnType<typeof useFocusStore.getState>['focus'] {
  return useFocusStore.getState().focus;
}

describe('core document panels: a row click highlights its entities on the model', () => {
  beforeEach(() => {
    resetStore();
    useFocusStore.setState({ focus: null });
  });

  it('Layers: the row focuses every entity of the layer with the layer colour and count', () => {
    const layerId = localDispatch('add_layer', { name: 'Walls', color: '#ff8800' }).affected[0]!;
    const a = addBox();
    const b = addBox();
    addBox();
    localDispatch('set_entity_layer', { entityId: a, layerId });
    localDispatch('set_entity_layer', { entityId: b, layerId });
    render(<LayersPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Highlight layer Walls on the model' }));
    expect(focus()?.key).toBe(`layers:layer:${layerId}`);
    expect(focus()?.color).toBe('#ff8800');
    expect(focus()?.entityIds).toEqual([a, b]);
    expect(focus()?.label).toContain('2 entities');
    expect(useStore.getState().document.selection).toEqual([a, b]);
  });

  it('Materials: the row focuses the entities using it and shows count, density unit and mass', () => {
    localDispatch('create_material', { name: 'steel', density: 0.00785, color: '#112233' });
    const a = addBox();
    addBox();
    localDispatch('assign_material', { materialName: 'steel', entityIds: [a] });
    render(<MaterialsPanel />);
    expect(screen.getByTestId('material-usage-steel').textContent).toMatch(/^1 object · /);
    expect(screen.getByTestId('material-row-steel').textContent).toContain('g/mm³');
    fireEvent.click(screen.getByRole('button', { name: 'Select material steel' }));
    expect(focus()?.key).toBe('materials:material:steel');
    expect(focus()?.color).toBe('#112233');
    expect(focus()?.entityIds).toEqual([a]);
    expect(focus()?.markers[0]?.label).toMatch(/kg|g$/);
  });

  it('Parameters: the name focuses the entities its =expr steps made; an unused parameter is not clickable', () => {
    localDispatch('set_parameter', { name: 'w', expression: '12' });
    localDispatch('set_parameter', { name: 'unused', expression: '1' });
    const driven = addDrivenBox();
    addBox();
    render(<ParametersPanel />);
    expect(screen.getByTestId('param-drives-w').textContent).toBe('→1');
    fireEvent.click(screen.getByRole('button', { name: 'Highlight objects driven by w' }));
    expect(focus()?.entityIds).toEqual([driven]);
    expect(focus()?.markers[0]?.label).toBe('w = 12');
    expect((screen.getByRole('button', { name: 'Highlight objects driven by unused' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('History: a step focuses the entities it affected; a suppressed step cannot', () => {
    const id = addBox();
    const stepId = useStore.getState().document.featureHistory.at(-1)!.id;
    render(<FeatureHistoryPanel />);
    fireEvent.click(screen.getByTestId(`history-step-${stepId}`).querySelector('.history-step-focus')!);
    expect(focus()?.entityIds).toEqual([id]);
    expect(useStore.getState().document.selection).toEqual([id]);
    act(() => {
      localDispatch('set_step_suppressed', { stepId, suppressed: true });
    });
    expect((screen.getByTestId(`history-step-${stepId}`).querySelector('.history-step-focus') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Configurations: shows the parameters that differ from the document and highlights what they drive', () => {
    localDispatch('set_parameter', { name: 'w', expression: '12' });
    const driven = addDrivenBox();
    localDispatch('create_configuration', { name: 'wide', parameterValues: { w: '40' } });
    render(<ConfigurationsPanel />);
    expect(screen.getByText('now 12')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Highlight objects driven by w' }));
    expect(focus()?.entityIds).toEqual([driven]);
  });

  it('Objects: a plain click selects and highlights with the size; a later selection change drops the highlight', () => {
    const id = addBox();
    const other = addBox();
    render(<ObjectsPanel />);
    const name = useStore.getState().document.entities[id]?.name ?? id;
    fireEvent.click(screen.getAllByRole('button', { name: /^Select (?!all)/ })[0]!);
    expect(useStore.getState().document.selection).toEqual([id]);
    expect(focus()?.key).toBe('objects:selection');
    expect(focus()?.markers[0]?.label).toBe('10 × 20 × 30 mm');
    expect(name).toBeDefined();
    useStore.getState().select([other]);
    return Promise.resolve().then(() => expect(focus()).toBeNull());
  });

  it('Properties: the headline shows the overall size and mass of a material solid', () => {
    localDispatch('create_material', { name: 'steel', density: 0.00785, color: '#112233' });
    const id = addBox();
    localDispatch('assign_material', { materialName: 'steel', entityIds: [id] });
    useStore.getState().select([id]);
    render(<PropertiesPanel />);
    expect(screen.getByTestId('kpi-overall').textContent).toContain('10 × 20 × 30 mm');
    expect(screen.getByTestId('kpi-material').textContent).toContain('steel');
    expect(screen.getByTestId('kpi-mass').textContent).toContain('47.1 g');
    fireEvent.click(screen.getByTestId('kpi-overall'));
    expect(focus()?.entityIds).toEqual([id]);
  });
});
