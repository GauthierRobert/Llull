import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ReviewPanel } from '@ui/panels/review/ReviewPanel';
import { ReadinessChecklist } from '@ui/panels/review/ReadinessChecklist';
import { buildChecklist } from '@ui/panels/review/checklist';
import { explainCliCommand } from '@ui/panels/review/explainCli';
import { parsePrototypeReview } from '@ui/panels/review/reviewTypes';
import { useReviewStore } from '@ui/panels/review/reviewStore';
import { useStore } from '@ui/store';
import { hardOverlap, reviewFixture, reviewWith, thinWall, withAccepted } from './reviewFixtures';
import { resetStore } from '../helpers/componentEntities';

function show(review = reviewFixture): void {
  const { document } = useStore.getState();
  act(() => useReviewStore.getState().setResult(review, { entities: document.entities, dynamics: document.dynamics }));
}

beforeEach(() => {
  resetStore();
  useReviewStore.setState({
    result: null,
    source: null,
    busy: false,
    status: '',
    checkFilter: 'all',
    severityFilter: 'all',
    reviewerFilter: 'all',
    sort: 'severity',
    group: 'none',
    explainKey: null,
  });
});

describe('ReviewPanel without the commands', () => {
  it('says checks are not available yet and does not dispatch', () => {
    const dispatch = vi.spyOn(useStore.getState(), 'dispatch');
    render(<ReviewPanel />);
    expect(screen.getByTestId('review-unavailable')).toHaveTextContent('not available yet');
    expect(screen.getByTestId('review-run')).toBeDisabled();
    fireEvent.click(screen.getByTestId('review-run'));
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('readiness checklist', () => {
  it('rows carry shape + word, the key value with unit and the threshold with its source', () => {
    render(<ReviewPanel />);
    show();
    const wall = screen.getByTestId('checklist-row-wall');
    expect(within(wall).getByText('warn')).toBeInTheDocument();
    expect(within(wall).getByText('▲')).toBeInTheDocument();
    expect(screen.getByTestId('checklist-value-wall')).toHaveTextContent('thickness 0.6 mm');
    expect(screen.getByTestId('checklist-threshold-wall')).toHaveTextContent('limit 0.794 mm (cnc_metal, Xometry, grade B)');
    const interference = screen.getByTestId('checklist-row-interference');
    expect(within(interference).getByText('fail')).toBeInTheDocument();
    expect(within(interference).getByText('✖')).toBeInTheDocument();
    expect(screen.getByTestId('checklist-value-interference')).toHaveTextContent('overlap volume 12.5 mm³');
    expect(within(screen.getByTestId('checklist-row-solid')).getByText('✔')).toBeInTheDocument();
    expect(within(screen.getByTestId('checklist-row-clearance')).getByText('○')).toBeInTheDocument();
    expect(within(screen.getByTestId('checklist-row-clearance')).getByText('not run')).toBeInTheDocument();
  });

  it('groups solver self-checks under their own sub-header, apart from Matches reality', () => {
    render(<ReadinessChecklist rows={buildChecklist(reviewFixture.checks, false)} onExplain={() => undefined} />);
    expect(screen.getByRole('heading', { name: 'Solver self-checks' })).toBeInTheDocument();
    const selfChecks = screen.getByRole('list', { name: 'Solver self-checks' });
    expect(within(selfChecks).getByText('Loops closed')).toBeInTheDocument();
    expect(within(selfChecks).queryByText('Matches reality')).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Readiness checks' })).getByText('Matches reality')).toBeInTheDocument();
  });

  it('shows every row stale (◌) once entities change after the run', () => {
    render(<ReviewPanel />);
    show();
    expect(screen.queryByTestId('review-stale')).toBeNull();
    act(() => useStore.setState((s) => ({ document: { ...s.document, entities: { ...s.document.entities } } })));
    expect(screen.getByTestId('review-stale')).toBeInTheDocument();
    expect(within(screen.getByTestId('checklist-row-wall')).getByText('◌')).toBeInTheDocument();
    expect(within(screen.getByTestId('checklist-row-wall')).getByText('stale')).toBeInTheDocument();
  });

  it('expands a row to its findings', () => {
    render(<ReviewPanel />);
    show();
    fireEvent.click(within(screen.getByTestId('checklist-row-interference')).getByRole('button', { name: 'No interference' }));
    expect(within(screen.getByRole('list', { name: 'No interference findings' })).getByText('FPR_PAIR_HARD')).toBeInTheDocument();
  });
});

describe('findings list', () => {
  it('filters by type, severity and reviewer status', () => {
    render(<ReviewPanel />);
    show();
    expect(screen.getByTestId('findings-count')).toHaveTextContent('3 of 3');
    fireEvent.change(screen.getByTestId('findings-filter-type'), { target: { value: 'dynamics' } });
    expect(screen.getByTestId('findings-count')).toHaveTextContent('1 of 3');
    fireEvent.change(screen.getByTestId('findings-filter-type'), { target: { value: 'all' } });
    fireEvent.change(screen.getByTestId('findings-filter-severity'), { target: { value: 'fail' } });
    expect(screen.getByTestId('findings-count')).toHaveTextContent('1 of 3');
    expect(screen.getByTestId(`finding-${hardOverlap.findingKey}`)).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('findings-filter-severity'), { target: { value: 'all' } });
    fireEvent.change(screen.getByTestId('findings-filter-reviewer'), { target: { value: 'accepted' } });
    expect(screen.getByTestId('findings-count')).toHaveTextContent('0 of 3');
  });

  it('sorts by value and groups by part', () => {
    render(<ReviewPanel />);
    show();
    const keys = (): string[] => screen.getAllByTestId(/^finding-/).map((el) => el.getAttribute('data-testid') ?? '');
    expect(keys()[0]).toBe(`finding-${hardOverlap.findingKey}`);
    fireEvent.change(screen.getByTestId('findings-sort'), { target: { value: 'value' } });
    expect(keys()[0]).toBe('finding-dynamics:FPR_REFERENCE_MISMATCH:crank');
    fireEvent.change(screen.getByTestId('findings-group'), { target: { value: 'part' } });
    expect(screen.getByRole('heading', { name: 'crankcase' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: /^(piston|head)$/ })).toHaveLength(2);
  });

  it('an accepted fail reads "fail (accepted)", never a pass, in the list and the checklist roll-up', () => {
    render(<ReviewPanel />);
    show(reviewWith({ assembly: [withAccepted(hardOverlap), thinWall] }));
    const row = screen.getByTestId(`finding-${hardOverlap.findingKey}`);
    expect(within(row).getByText('fail (accepted)')).toBeInTheDocument();
    expect(within(row).getByText('✖')).toBeInTheDocument();
    expect(within(screen.getByTestId('checklist-row-interference')).getByText('fail')).toBeInTheDocument();
    expect(within(screen.getByTestId('checklist-row-interference')).queryByText('pass')).toBeNull();
  });

  it('disables reviewer controls with a note while set_review_disposition is not registered', () => {
    render(<ReviewPanel />);
    show();
    expect(screen.getByTestId('findings-disposition-unavailable')).toBeInTheDocument();
    expect(screen.getByLabelText('Reviewer status for FPR_PAIR_HARD')).toBeDisabled();
  });
});

describe('Explain drawer', () => {
  it('shows method, threshold, accuracy block and a copy-as-CLI line for a finding', () => {
    render(<ReviewPanel />);
    show();
    fireEvent.click(within(screen.getByTestId('checklist-row-reality')).getByRole('button', { name: 'Explain Matches reality' }));
    const drawer = screen.getByTestId('explain-drawer');
    expect(within(drawer).getByText('FPR_REFERENCE_MISMATCH')).toBeInTheDocument();
    expect(screen.getByTestId('explain-method')).toHaveTextContent('dynamics method v1');
    const accuracy = screen.getByTestId('explain-accuracy-brakeTorqueNm');
    expect(accuracy).toHaveTextContent('± 5 %');
    expect(accuracy).toHaveTextContent('predicted');
    expect(accuracy).toHaveTextContent('validation level 2');
    expect(accuracy).toHaveTextContent('S 71.2 · D 80 · E -8.8 · U_val 4');
    expect(accuracy).toHaveTextContent('no torsional resonance');
    expect(screen.getByTestId('explain-unverified')).toBeInTheDocument();
    expect(screen.getByTestId('explain-cli')).toHaveTextContent(`llull exec simulate_motion '{"clearanceMm":0.5}'`);
  });

  it('copies the CLI string to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ReviewPanel />);
    show();
    act(() => useReviewStore.getState().openExplain(hardOverlap.findingKey));
    fireEvent.click(await screen.findByTestId('explain-copy-cli'));
    expect(writeText).toHaveBeenCalledWith(`llull exec check_assembly '{"clearanceMm":0.5}'`);
  });

  it('quotes single quotes for the shell and shows "± ?" when a value has no accuracy estimate', () => {
    const check = reviewFixture.checks[0];
    if (check === undefined) throw new Error('fixture');
    expect(explainCliCommand({ ...check, provenance: { ...check.provenance, params: { note: "it's" } } })).toContain(
      `'{"note":"it'\\''s"}'`,
    );
    render(<ReviewPanel />);
    show();
    act(() => useReviewStore.getState().openExplain(hardOverlap.findingKey));
    expect(screen.getByText(/± \? \(no accuracy estimate\)/)).toBeInTheDocument();
  });
});

describe('parsePrototypeReview', () => {
  it('accepts the check envelope and rejects other shapes', () => {
    expect(parsePrototypeReview(reviewFixture)?.checks).toHaveLength(4);
    expect(parsePrototypeReview({ checks: [{ check: 'nope' }] })).toBeNull();
    expect(parsePrototypeReview(null)).toBeNull();
  });
});
