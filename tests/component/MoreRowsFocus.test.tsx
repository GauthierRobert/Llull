import { resetStore } from '../helpers/componentEntities';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useStore } from '@ui/store';
import { useFocusStore } from '@ui/store/focusStore';
import { BuildingPanel } from '@ui/panels/building/BuildingPanel';
import { QuantitiesSection } from '@ui/panels/building/QuantitiesSection';
import { ManufacturingPanel } from '@ui/panels/manufacturing/ManufacturingPanel';
import { bomPartFocus } from '@ui/panels/fasteners/fastenerFocus';
import { holeFocus } from '@ui/panels/manufacturing/mfgFocus';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import type { GeometryKernel } from '@core/geometry/kernel';
import { localDispatch, liveSnapshot } from '../helpers/storeTestHelpers';
import { bracket } from '../unit/aero/sheetmetal/helpers';
import { ctxWith, docWith, inchDocument, ok } from '../unit/aero/fasteners/fixtures';

const focus = (): ReturnType<typeof useFocusStore.getState>['focus'] => useFocusStore.getState().focus;

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});
beforeEach(() => {
  resetStore();
  useFocusStore.setState({ focus: null });
});

describe('every list row with a place on the model highlights it', () => {
  it('a building level row highlights the elements on that level', () => {
    localDispatch('add_portal_frame_building', {});
    render(<BuildingPanel />);
    const row = screen.getAllByTestId(/^level-row-/)[0]!;
    fireEvent.click(row.querySelector('button')!);
    expect(focus()?.key.startsWith('building:level:')).toBe(true);
    expect(focus()?.entityIds.length).toBeGreaterThan(0);
  });

  it('a quantity takeoff line highlights the elements of its category', () => {
    localDispatch('add_portal_frame_building', {});
    render(<QuantitiesSection />);
    const header = screen.queryByRole('button', { name: /quantit/i });
    if (header !== null && header.getAttribute('aria-expanded') === 'false') fireEvent.click(header);
    const show = screen.getAllByTestId(/^takeoff-show-/)[0]!;
    fireEvent.click(show);
    expect(focus()?.key.startsWith('building:takeoff:')).toBe(true);
    expect(focus()?.entityIds.length).toBeGreaterThan(0);
  });

  it('a flat-pattern bend row beacons that bend on the folded part', async () => {
    const { doc } = bracket();
    act(() => useStore.getState().hydrateLiveDocument(liveSnapshot(doc)));
    render(<ManufacturingPanel />);
    fireEvent.click(screen.getByTestId('flat-toggle'));
    const bend = await waitFor(() => screen.getByTestId('bend-show-b1'));
    fireEvent.click(bend);
    expect(focus()?.key).toBe('manufacturing:bend:b1');
    expect(focus()?.markers[0]?.position[0]).toBeCloseTo(33.6);
  });

  it('a feature-table hole beacons its centre (hole_table reports it in world coordinates)', () => {
    const id = localDispatch('add_box', { size: [10, 10, 10], position: [100, 0, 0] }).affected[0]!;
    const hole = holeFocus(useStore.getState().document, id, 'H1 · Ø4', [101, 2, 5]);
    expect(hole.markers).toEqual([{ position: [101, 2, 5], label: 'H1 · Ø4' }]);
    expect(hole.entityIds).toEqual([id]);
  });

  it('a BOM part number highlights every placed instance of it', () => {
    const plates = ok(docWith(undefined, inchDocument()), 'add_box', { size: [2, 1, 0.25], anchor: 'min', position: [0, 0, 0] });
    let doc = plates.document;
    for (const x of [0.5, 1.5])
      doc = ok(
        doc,
        'insert_fastener_stack',
        {
          family: 'NAS6203-6220',
          diameterDash: '3',
          stackIds: [plates.affected[0]],
          axisPoint: [x, 0.5, 0],
          nut: 'MS21042',
          holeMode: 'none',
        },
        ctxWith(kernel),
      ).document;
    const stack = Object.values(doc.fasteners?.stacks ?? {})[0]!;
    const bolt = bomPartFocus(doc, stack.fastener.partNumber);
    expect(bolt.entityIds).toHaveLength(2);
    expect(bolt.markers).toHaveLength(2);
    expect(bolt.label).toBe(`${stack.fastener.partNumber} × 2`);
  });
});
