import { resetStore } from '../helpers/componentEntities';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useStore } from '@ui/store';
import { useFocusStore } from '@ui/store/focusStore';
import { useStructuralOverlayStore } from '@ui/store/structuralOverlayStore';
import { useReviewStore } from '@ui/panels/review/reviewStore';
import { MechanismsPanel } from '@ui/panels/MechanismsPanel';
import { BuildingPanel } from '@ui/panels/building/BuildingPanel';
import { CivilPanel } from '@ui/panels/civil/CivilPanel';
import { ReviewPanel } from '@ui/panels/review/ReviewPanel';
import { ManufacturingPanel } from '@ui/panels/manufacturing/ManufacturingPanel';
import { FastenersPanel } from '@ui/panels/fasteners/FastenersPanel';
import { localDispatch } from '../helpers/storeTestHelpers';
import { liveSnapshot } from '../helpers/storeTestHelpers';
import { SURVEY } from '../helpers/civilPanel';
import { bracket } from '../unit/aero/sheetmetal/helpers';
import { ctxWith, docWith, inchDocument, ok } from '../unit/aero/fasteners/fixtures';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { hardOverlap, reviewFixture } from './reviewFixtures';
import { mechanismCounts } from '@ui/panels/mechanismFocus';
import { toUtilisationMarks, utilisationBand, utilisationColor, UTILISATION_COLORS } from '@ui/panels/building/utilisationColor';
import type { ReportRow } from '@ui/panels/building/structuralReport';
import type { GeometryKernel } from '@core/geometry/kernel';

const focus = (): ReturnType<typeof useFocusStore.getState>['focus'] => useFocusStore.getState().focus;

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});
beforeEach(() => {
  resetStore();
  useFocusStore.setState({ focus: null });
  useStructuralOverlayStore.setState({ shown: true, marks: [] });
});

describe('utilisation colouring (pure)', () => {
  it('bands: green below 0.7, amber below 1, red from 1 or when the check says it fails', () => {
    expect([0.2, 0.69].map((u) => utilisationBand(u))).toEqual(['ok', 'ok']);
    expect([0.7, 0.99].map((u) => utilisationBand(u))).toEqual(['warn', 'warn']);
    expect([1, 1.12].map((u) => utilisationBand(u))).toEqual(['fail', 'fail']);
    expect(utilisationBand(0.3, false)).toBe('fail');
    expect(utilisationColor(0.5)).toBe(UTILISATION_COLORS.ok);
  });
  it('turns report rows into overlay marks and drops rows without geometry', () => {
    const rows: ReportRow[] = [
      { key: '0:a', elementId: 'a', label: 'Col', utilisation: 1.2, ok: true, detail: '' },
      { key: '1:b', elementId: 'b', label: 'Gone', utilisation: 0.5, ok: true, detail: '' },
    ];
    const building = { elements: { a: { entityIds: ['e1'] } } } as never;
    expect(toUtilisationMarks(rows, building)).toEqual([{ key: '0:a', entityIds: ['e1'], utilisation: 1.2, failing: true, label: 'Col' }]);
  });
});

describe('utilisation marks (pure)', () => {
  it('one mark per element, coloured by its governing (worst) row', () => {
    const building = { elements: { a: { entityIds: ['e1'] }, b: { entityIds: ['e2'] } } } as never;
    const row = (key: string, elementId: string, utilisation: number): ReportRow => ({
      key,
      elementId,
      label: key,
      utilisation,
      ok: true,
      detail: '',
    });
    const marks = toUtilisationMarks([row('0', 'a', 0.4), row('1', 'a', 0.9), row('2', 'b', 0.2)], building);
    expect(marks.map((mark) => [mark.entityIds[0], mark.utilisation])).toEqual([
      ['e1', 0.9],
      ['e2', 0.2],
    ]);
  });
});

describe('Building: structural and clash rows highlight on the model', () => {
  it('colours the checked members, shows the KPI strip and focuses a member with its UR', () => {
    localDispatch('add_portal_frame_building', {});
    render(<BuildingPanel />);
    fireEvent.click(screen.getByTestId('frame-check'));
    expect(screen.getByTestId('kpi-max-ur')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-failing')).toBeInTheDocument();
    expect(useStructuralOverlayStore.getState().marks.length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByTestId('frame-check-row')[0]!);
    expect(focus()?.key.startsWith('building:member:')).toBe(true);
    expect(focus()?.entityIds.length).toBeGreaterThan(0);
    expect(focus()?.markers[0]?.label).toMatch(/UR \d\.\d\d/);
    expect(useStore.getState().document.selection.length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId('utilisation-shown'));
    expect(useStructuralOverlayStore.getState().shown).toBe(false);
  });
});

describe('Mechanisms', () => {
  function buildJoint(): string {
    const a = localDispatch('add_box', { size: [1, 1, 1] }).affected[0]!;
    const b = localDispatch('add_box', { size: [1, 1, 1] }).affected[0]!;
    localDispatch('create_component', { name: 'A', entityIds: [a] });
    localDispatch('create_component', { name: 'B', entityIds: [b] });
    const components = Object.keys(useStore.getState().document.components);
    const i1 = localDispatch('insert_instance', { componentId: components[0] }).affected[0]!;
    const i2 = localDispatch('insert_instance', { componentId: components[1] }).affected[0]!;
    return localDispatch('add_joint', { kind: 'revolute', a: { instanceId: i1 }, b: { instanceId: i2 }, axis: 'z' }).affected[0]!;
  }
  it('a joint row focuses its instances with a beacon and the KPI strip counts joints', () => {
    const jointId = buildJoint();
    render(<MechanismsPanel />);
    expect(screen.getByTestId('kpi-joints')).toHaveTextContent('1');
    fireEvent.click(screen.getByTestId(`joint-focus-${jointId}`));
    expect(focus()?.key).toBe(`mechanisms:joint:${jointId}`);
    expect(focus()?.entityIds).toHaveLength(2);
    expect(focus()?.markers[0]?.label).toMatch(/revolute/);
    fireEvent.click(screen.getByTestId(`joint-focus-${jointId}`));
    expect(focus()).toBeNull();
  });
  it('a constraint row focuses both constrained entities', () => {
    const a = localDispatch('add_box', { size: [1, 1, 1] }).affected[0]!;
    const b = localDispatch('add_sphere', { radius: 1 }).affected[0]!;
    const id = localDispatch('add_constraint', { constraint: { kind: 'distance', a: { entityId: a }, b: { entityId: b }, value: '5' } })
      .affected[0]!;
    render(<MechanismsPanel />);
    fireEvent.click(screen.getByTestId(`constraint-focus-${id}`));
    expect(focus()?.entityIds).toEqual([a, b]);
  });
  it('counts bodies and mobility of a document without dynamics as zero', () => {
    expect(mechanismCounts(useStore.getState().document)).toMatchObject({ bodies: 0, mobility: 0, joints: 0 });
  });
});

describe('Civil', () => {
  it('a civil object row focuses its generated entities', () => {
    localDispatch('import_survey_points', { text: SURVEY, name: 'Topo' });
    render(<CivilPanel />);
    fireEvent.click(screen.getByTestId('civil-focus-pointGroup-1'));
    expect(focus()?.key).toBe('civil:pointGroup:pointGroup-1');
    expect(focus()?.label).toContain('Topo');
    // one beacon per survey point, labelled with its number and elevation
    expect(focus()?.markers).toHaveLength(4);
    expect(focus()?.markers[0]?.label).toBe('1 · 10 m');
  });
});

describe('Fasteners', () => {
  it('a stack row focuses the stack and beacons the axis with the part number', () => {
    const plates = ok(docWith(undefined, inchDocument()), 'add_box', { size: [2, 1, 0.25], anchor: 'min', position: [0, 0, 0] });
    const stacked = ok(
      plates.document,
      'insert_fastener_stack',
      {
        family: 'NAS6203-6220',
        diameterDash: '3',
        stackIds: [plates.affected[0]],
        axisPoint: [1, 0.5, 0],
        nut: 'MS21042',
        holeMode: 'none',
      },
      ctxWith(kernel),
    );
    act(() => useStore.getState().hydrateLiveDocument(liveSnapshot(stacked.document)));
    render(<FastenersPanel />);
    const stackId = Object.keys(useStore.getState().document.fasteners?.stacks ?? {})[0] ?? '';
    fireEvent.click(screen.getByTestId(`stack-focus-${stackId}`));
    expect(focus()?.key).toBe(`fasteners:stack:${stackId}`);
    expect(focus()?.markers[0]?.label).toContain('NAS6203');
    expect(focus()?.entityIds.length).toBeGreaterThan(1);
  });
});

describe('Manufacturing', () => {
  it('Show highlights the part and a finding Show beacons it with the finding code', () => {
    const { doc, part } = bracket();
    act(() => useStore.getState().hydrateLiveDocument(liveSnapshot(doc)));
    render(<ManufacturingPanel />);
    fireEvent.click(screen.getByTestId('mfg-part-show'));
    expect(focus()?.entityIds).toEqual([part]);
    fireEvent.click(screen.getByTestId('ftr-run'));
    expect(screen.getByTestId('kpi-status')).toBeInTheDocument();
    const show = screen.getAllByTestId(/ftr-finding-show-/)[0]!;
    fireEvent.click(show);
    expect(focus()?.key.startsWith('manufacturing:finding:')).toBe(true);
    expect(focus()?.entityIds).toEqual([part]);
  });
});

describe('Review', () => {
  it('shows the verdict KPIs, the overlay toggle, and a finding Show focuses its parts', () => {
    const a = localDispatch('add_box', { size: [1, 1, 1] }).affected[0]!;
    const review = {
      ...reviewFixture,
      checks: [{ ...reviewFixture.checks[0]!, items: [{ ...hardOverlap, ids: [a], witness: { pointsMm: [[1, 2, 3]] as const } }] }],
    };
    const { document } = useStore.getState();
    act(() => useReviewStore.getState().setResult(review, { entities: document.entities, dynamics: document.dynamics }));
    render(<ReviewPanel />);
    expect(screen.getByTestId('kpi-review-fail')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`finding-show-${hardOverlap.findingKey}`));
    expect(focus()?.entityIds).toEqual([a]);
    expect(focus()?.markers[0]?.position).toEqual([1, 2, 3]);
    fireEvent.click(screen.getByTestId('review-markers-shown'));
    expect(useReviewStore.getState().markersShown).toBe(false);
  });
});
