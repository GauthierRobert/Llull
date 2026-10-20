// PHY-21 M5 Review tab on a check_prototype result: VC-FPR-22 (an accepted fail stays a fail), VC-FPR-25 (checklist row = icon + word +
// value + source, accuracy badges, finding click focuses the model, mechanism graph), VC-FPR-26 (shared timeline: scrubbing moves the chart
// cursor, crank axis with the TDC mark, a collision event seeks), FR-FPR-63 (reference overlay).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { SimulationData } from '@core/dynamics/simulationReport';
import type { DynamicsModel } from '@core/model/dynamics';
import { ReviewPanel } from '@ui/panels/review/ReviewPanel';
import { MechanismGraph } from '@ui/panels/review/MechanismGraph';
import { ReviewTimeline } from '@ui/panels/review/ReviewTimeline';
import { ReferenceChart } from '@ui/panels/review/ReferenceChart';
import { useReviewStore } from '@ui/panels/review/reviewStore';
import type { CheckItem, CheckResult, PrototypeReview } from '@ui/panels/review/reviewTypes';
import { useStore } from '@ui/store';
import { useFocusStore } from '@ui/store/focusStore';
import { useDynamicsPlaybackStore } from '@ui/store/dynamicsPlaybackStore';
import { resetStore } from '../helpers/componentEntities';
import { sliderCrank } from '../unit/sliderCrankFixture';
import { hardOverlap, thinWall } from './reviewFixtures';

const accepted: CheckItem = {
  ...hardOverlap,
  disposition: { status: 'accepted', comment: 'press fit by design', by: 'agent', stale: false },
};

const calibration: CheckItem = {
  code: 'FPR_REFERENCE_MATCH',
  status: 'info',
  ids: ['rated_point'],
  findingKey: 'dynamics:FPR_REFERENCE_MATCH:rated_point@5800',
  values: { rpm: 5800, simulated: 11.24, reference: 11.2477, error: -0.0077, errorRel: -0.0007, bandRel: 0.05 },
  accuracy: {
    simulated: { band: { rel: 0.001 }, basis: 'calibrated brake value', origin: 'calibrated', validationLevel: 1, warnings: [] },
  },
  remediation: 'None.',
  unverified: true,
};

const holdOut: CheckItem = {
  ...calibration,
  status: 'fail',
  code: 'FPR_REFERENCE_MISMATCH',
  findingKey: 'dynamics:FPR_REFERENCE_MISMATCH:rated_point@4000',
  values: { rpm: 4000, simulated: 9.1, reference: 11.06, error: -1.96, errorRel: -0.18, bandRel: 0.05, validationUncertainty: 0.3 },
  accuracy: { simulated: { band: null, basis: 'single-zone prediction', origin: 'predicted', validationLevel: 0, warnings: [] } },
};

const collision: CheckItem = {
  code: 'FPR_MOTION_INTERFERENCE',
  status: 'fail',
  ids: ['arm', 'stop'],
  findingKey: 'motion_clearance:FPR_MOTION_INTERFERENCE:arm,stop',
  values: { intervals: 1, minDistanceMm: 0 },
  witness: { pointsMm: [[1, 2, 3]], timeS: 2.5, crankDeg: 900 },
  remediation: 'Move a part.',
};

function check(name: CheckResult['check'], status: CheckResult['status'], items: readonly CheckItem[]): CheckResult {
  return {
    check: name,
    status,
    items,
    provenance: { method: `${name} v1`, tolerances: {}, params: {} },
    inputsHash: `hash-${name}`,
    unverified: false,
    reviewRequired: true,
  };
}

const review: PrototypeReview = {
  verdict: 'blocked',
  ownerSummary: 'Blocked. 1 fail (1 accepted, still fails).',
  staleDispositions: ['assembly:FPR_WALL_THIN:crankcase'],
  durationS: 4,
  checks: [
    check('assembly', 'fail', [accepted, thinWall]),
    check('mechanism', 'pass', []),
    check('motion_clearance', 'fail', [collision]),
    check('dynamics', 'fail', [calibration, holdOut]),
  ],
};

function show(result: PrototypeReview = review): void {
  const { document } = useStore.getState();
  act(() => useReviewStore.getState().setResult(result, { entities: document.entities, dynamics: document.dynamics }));
}

beforeEach(() => {
  resetStore();
  useReviewStore.setState({
    result: null,
    source: null,
    explainKey: null,
    checkFilter: 'all',
    severityFilter: 'all',
    reviewerFilter: 'all',
  });
  useFocusStore.setState({ focus: null });
  useDynamicsPlaybackStore.setState({ result: null, time: 0, cursorTime: 0, axis: 'time', playing: false });
});

describe('Review tab on a check_prototype result', () => {
  it('VC-FPR-22: an accepted fail reads "fail (accepted)" and the verdict stays blocked; stale dispositions are listed', () => {
    render(<ReviewPanel />);
    show();
    expect(screen.getByTestId('review-verdict')).toHaveTextContent(/blocked/);
    const row = screen.getByTestId(`finding-${accepted.findingKey}`);
    expect(within(row).getByText('fail (accepted)')).toBeInTheDocument();
    expect(within(row).getByText('agent')).toBeInTheDocument();
    expect(screen.getByTestId('review-stale-dispositions')).toHaveTextContent('assembly:FPR_WALL_THIN:crankcase');
  });

  it("dispatches set_review_disposition with the inputsHash of the finding's check", () => {
    const dispatch = vi.fn();
    useStore.setState({ dispatch });
    render(<ReviewPanel />);
    show();
    fireEvent.change(screen.getByLabelText('Reviewer status for FPR_WALL_THIN'), { target: { value: 'irrelevant' } });
    expect(dispatch).toHaveBeenCalledWith('set_review_disposition', {
      findingKey: thinWall.findingKey,
      status: 'irrelevant',
      comment: '',
      inputsHash: 'hash-assembly',
    });
  });

  it('joins the document dispositions over the stored result at once, without re-running the checks', async () => {
    render(<ReviewPanel />);
    show();
    const disposed = (hash: string): void =>
      act(() =>
        useStore.setState({
          document: {
            ...useStore.getState().document,
            prototype: {
              intents: {},
              grounded: [],
              dispositions: {
                [thinWall.findingKey]: {
                  findingKey: thinWall.findingKey,
                  status: 'accepted',
                  comment: 'ok',
                  inputsHash: hash,
                  by: 'agent',
                },
              },
            },
          },
        }),
      );
    disposed('hash-assembly');
    const row = await screen.findByTestId(`finding-${thinWall.findingKey}`);
    expect(within(row).getByText('warn (accepted)')).toBeInTheDocument();
    expect(useReviewStore.getState().busy).toBe(false);
    // the fixture's own accepted disposition is not in the document any more: it is cleared, and the stale list is recomputed
    expect(within(screen.getByTestId(`finding-${accepted.findingKey}`)).queryByText('fail (accepted)')).toBeNull();
    expect(screen.queryByTestId('review-stale-dispositions')).toBeNull();
    disposed('older-hash');
    expect(await screen.findByTestId('review-stale-dispositions')).toHaveTextContent(thinWall.findingKey);
    expect(within(screen.getByTestId(`finding-${thinWall.findingKey}`)).getByText('stale')).toBeInTheDocument();
  });

  it('VC-FPR-25: a checklist row shows icon + word + value + threshold with its source; calibrated values are information with a badge', () => {
    render(<ReviewPanel />);
    show();
    const wall = screen.getByTestId('checklist-row-wall');
    expect(within(wall).getByText('▲')).toBeInTheDocument();
    expect(within(wall).getByText('warn')).toBeInTheDocument();
    expect(within(wall).getByTestId('checklist-value-wall')).toHaveTextContent('thickness 0.6 mm');
    expect(within(wall).getByTestId('checklist-threshold-wall')).toHaveTextContent(/0\.794 mm \(cnc_metal, Xometry, grade B\)/);
    const reality = screen.getByTestId('checklist-row-reality');
    expect(reality.querySelector('.status-mark')?.getAttribute('data-status')).toBe('fail');
    const badge = screen.getByTestId(`finding-accuracy-${calibration.findingKey}`);
    expect(badge).toHaveTextContent('± 0.1 %');
    expect(badge).toHaveTextContent('calibrated');
    expect(badge).toHaveClass('accuracy-badge--calibrated');
    expect(screen.getByTestId(`finding-accuracy-${holdOut.findingKey}`)).toHaveTextContent('± ?');
    // a calibration point alone is information, never a green pass
    const onlyCalibration = { ...review, checks: review.checks.map((c) => (c.check === 'dynamics' ? { ...c, items: [calibration] } : c)) };
    show(onlyCalibration);
    expect(screen.getByTestId('checklist-row-reality').querySelector('.status-mark')?.getAttribute('data-status')).toBe('info');
  });

  it('VC-FPR-25: clicking "Show" on a finding focuses its parts on the model', () => {
    render(<ReviewPanel />);
    show();
    fireEvent.click(screen.getByTestId(`finding-show-${collision.findingKey}`));
    expect(useFocusStore.getState().focus?.key).toBe(`review:finding:${collision.findingKey}`);
  });
});

describe('Mechanism graph', () => {
  it('draws ground and bodies, the loop-closing joint dashed, the DOF badge; clicking a body focuses it', () => {
    useStore.setState({ document: sliderCrank().doc });
    render(<MechanismGraph />);
    expect(screen.getByTestId('mechanism-graph-dof')).toHaveTextContent('1 DOF');
    for (const id of ['ground', 'crank', 'rod', 'piston']) expect(screen.getByTestId(`mechanism-node-${id}`)).toBeInTheDocument();
    expect(screen.getByTestId('mechanism-edge-wrist_j')).toHaveClass('mechanism-graph__edge--loop');
    expect(screen.getByTestId('mechanism-edge-crank_j')).toHaveClass('mechanism-graph__edge--tree');
    fireEvent.click(screen.getByTestId('mechanism-node-rod'));
    expect(useFocusStore.getState().focus?.key).toBe('mechanisms:body:rod');
    expect(screen.getByTestId('mechanism-node-rod')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Review timeline (VC-FPR-26)', () => {
  const times = [0, 1, 2, 3, 4];
  const crankRad = [0, Math.PI, 2 * Math.PI, 3 * Math.PI, 4 * Math.PI];
  function engineDoc(): void {
    const { doc } = sliderCrank();
    const dynamics = doc.dynamics as DynamicsModel;
    const cylinder = { id: 'cyl', crank: 'crank_j', piston: 'slide_j', cycle: 'four_stroke', firingOffsetDeg: 0, tdcCrankAngleRad: 0 };
    useStore.setState({ document: { ...doc, dynamics: { ...dynamics, cylinders: { cyl: cylinder } } as unknown as DynamicsModel } });
    const result = {
      duration: 4,
      engine: 'mujoco',
      joints: {},
      series: {
        times,
        jointVelocity: { crank_j: [10, 10, 10, 10, 10] },
        jointPosition: { crank_j: crankRad },
        motorTorque: {},
        propellerThrust: {},
        propellerPower: {},
      },
      reactions: {
        joints: { rod_j: { forceN: { value: 50, timeS: 3, angleDeg: 180 }, momentNm: { value: 0, timeS: 0, angleDeg: null } } },
        series: { times, joints: { rod_j: { force: times.map((t) => [t * 10, 0, 0]), moment: times.map(() => [0, 0, 0]) } } },
      },
    } as unknown as SimulationData;
    useDynamicsPlaybackStore.setState({ result, time: 0, cursorTime: 0 });
  }

  it('scrubbing moves every chart cursor; the crank axis spans 0-720 deg with the TDC mark; events seek', () => {
    engineDoc();
    render(<ReviewTimeline checks={review.checks} durationS={4} />);
    const before = screen.getByTestId('review-speed-chart-cursor').getAttribute('x1');
    fireEvent.change(screen.getByTestId('review-timeline-scrub'), { target: { value: '2' } });
    expect(useDynamicsPlaybackStore.getState().cursorTime).toBe(2);
    expect(screen.getByTestId('review-speed-chart-cursor').getAttribute('x1')).not.toBe(before);
    expect(screen.getByTestId('review-reaction-chart-cursor').getAttribute('x1')).toBe(
      screen.getByTestId('review-speed-chart-cursor').getAttribute('x1'),
    );
    fireEvent.change(screen.getByTestId('review-timeline-axis'), { target: { value: 'crank' } });
    expect(screen.getByRole('img', { name: /Crank speed: .* at 360 ° crank/ })).toBeInTheDocument();
    expect(screen.getAllByTestId('review-speed-chart-mark').map((mark) => mark.textContent)).toEqual(['TDC 1', 'TDC 1']);
    fireEvent.click(within(screen.getByTestId('review-timeline-markers')).getByRole('button', { name: /arm \/ stop/ }));
    expect(useDynamicsPlaybackStore.getState().cursorTime).toBe(2.5);
  });
});

describe('Reference overlay (FR-FPR-63)', () => {
  it('draws calibration and hold-out points with distinct markers and can hide the calibration points', () => {
    render(<ReferenceChart checks={review.checks} />);
    expect(screen.getAllByTestId('reference-point-calibration')).toHaveLength(1);
    expect(screen.getAllByTestId('reference-point-holdout')).toHaveLength(1);
    expect(screen.getByTestId('reference-point-holdout')).toHaveTextContent(/S 9\.1 · D 11\.1 · E -1\.96 · U_val 0\.3/);
    fireEvent.click(screen.getByTestId('reference-holdout-only'));
    expect(screen.queryByTestId('reference-point-calibration')).toBeNull();
  });
});
