import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { execute } from '@core/commands/registry';
import { statusPayload } from '@core/commands/review/reviewActs';
import { humanCtx } from '../unit/review/humanActs';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { ReviewPanel } from '@ui/panels/review/ReviewPanel';
import { useStore } from '@ui/store';
import { useRedlineStore } from '@ui/store/redlineStore';
import { MarkupOverlay } from '@ui/viewport/3d/review/MarkupOverlay';

const mocks = vi.hoisted(() => ({ snapshot: { position: [5, 10, 15], target: [0, 0, 0] } as unknown }));
vi.mock('@ui/viewport/3d/cameraBridge', () => ({ getCameraSnapshot: () => mocks.snapshot }));

function documentWithIssue(): CadDocument {
  let doc = createEmptyDocument();
  doc = execute(doc, 'add_box', { position: [0, 0, 0], size: [2, 2, 2] }).document;
  doc = execute(doc, 'save_viewpoint', {
    name: 'Pump skid',
    camera: { projection: 'perspective', eye: [0, -50, 10], direction: [0, 1, 0] },
  }).document;
  doc = execute(doc, 'create_review_issue', {
    title: 'Line 102 clashes',
    priority: 'high',
    assignedTo: 'ana',
    viewpointIds: ['vp-1'],
  }).document;
  return doc;
}

let dispatch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  dispatch = vi.fn();
  useRedlineStore.setState(useRedlineStore.getInitialState(), true);
  useStore.setState({ document: documentWithIssue(), dispatch: dispatch as never });
});

const openIssue = (): HTMLElement => {
  fireEvent.click(screen.getByLabelText('Issue iss-2: Line 102 clashes'));
  return screen.getByTestId('issue-detail');
};

describe('Review panel: issues', () => {
  it('lists issues with status, priority and assignee', () => {
    render(<ReviewPanel />);
    const row = screen.getByTestId('issue-iss-2');
    expect(row).toHaveTextContent('Open');
    expect(row).toHaveTextContent('Line 102 clashes');
    expect(row).toHaveTextContent('high · ana');
  });

  it('creates an issue on the selection and the redline viewpoint', () => {
    useStore.setState({ document: { ...useStore.getState().document, selection: ['box-1'] } });
    useRedlineStore.getState().setViewpointId('vp-1');
    render(<ReviewPanel />);
    fireEvent.change(screen.getByLabelText('New issue title'), { target: { value: 'Missing guard' } });
    fireEvent.click(screen.getByText('Add issue'));
    expect(dispatch).toHaveBeenCalledWith('create_review_issue', {
      title: 'Missing guard',
      priority: 'normal',
      entityIds: ['box-1'],
      viewpointIds: ['vp-1'],
    });
  });

  it('adds a comment as a human and goes to the issue viewpoint', () => {
    render(<ReviewPanel />);
    const detail = openIssue();
    fireEvent.change(within(detail).getByLabelText('Comment on iss-2'), { target: { value: 'Move the tray' } });
    fireEvent.click(within(detail).getByText('Comment'));
    expect(dispatch).toHaveBeenCalledWith('add_review_comment', { issueId: 'iss-2', text: 'Move the tray', author: 'human' });
    fireEvent.click(within(detail).getByTitle('Go to Pump skid'));
    expect(dispatch).toHaveBeenCalledWith('apply_viewpoint', { id: 'vp-1' });
    expect(useRedlineStore.getState().viewpointId).toBe('vp-1');
  });

  it('shows the comments of the issue', () => {
    const doc = execute(useStore.getState().document, 'add_review_comment', { issueId: 'iss-2', text: 'First note' }).document;
    useStore.setState({ document: doc });
    render(<ReviewPanel />);
    expect(within(openIssue()).getByTestId('issue-comment')).toHaveTextContent('First note');
  });

  it('moves to an unsigned status without a confirmation', () => {
    render(<ReviewPanel />);
    const detail = openIssue();
    fireEvent.change(within(detail).getByLabelText('Move iss-2 to'), { target: { value: 'in_progress' } });
    fireEvent.change(within(detail).getByLabelText('Reason for moving iss-2'), { target: { value: 'on it' } });
    fireEvent.click(within(detail).getByText('Move'));
    expect(dispatch).toHaveBeenCalledWith(
      'set_issue_status',
      { issueId: 'iss-2', status: 'in_progress', reason: 'on it' },
      expect.anything(),
    );
  });

  it('closing is a signed act: the dialog signs the issue-bound payload and the command gets the signature, never a flag', async () => {
    const signed: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/signing/keys'))
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [{ keyId: 'k-1', userId: 'u-1', name: 'J. Example', trusted: true }] }), { status: 200 }),
        );
      signed.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Promise.resolve(
        new Response(
          JSON.stringify({ signature: { alg: 'Ed25519', keyId: 'k-1', publicKey: 'a'.repeat(64), signature: 'b'.repeat(128) } }),
          { status: 200 },
        ),
      );
    });
    render(<ReviewPanel />);
    const detail = openIssue();
    fireEvent.change(within(detail).getByLabelText('Move iss-2 to'), { target: { value: 'closed' } });
    fireEvent.change(within(detail).getByLabelText('Reason for moving iss-2'), { target: { value: 'tray moved' } });
    fireEvent.click(within(detail).getByText('Sign and move'));
    expect(dispatch).not.toHaveBeenCalled();
    await screen.findByText(/J. Example/);
    fireEvent.change(screen.getByTestId('sign-passphrase'), { target: { value: 'a long passphrase' } });
    fireEvent.click(screen.getByTestId('sign-confirm'));
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    const [name, params] = dispatch.mock.calls[0] as [string, { confirmation: { nonce: string } }];
    expect(name).toBe('set_issue_status');
    expect(params).toMatchObject({
      issueId: 'iss-2',
      status: 'closed',
      reason: 'tray moved',
      confirmation: { alg: 'Ed25519', keyId: 'k-1' },
    });
    const issue = useStore.getState().document.review?.issues['iss-2'];
    expect(signed[0]).toMatchObject({ kind: 'payload', act: 'set_issue_status' });
    // The signed bytes are exactly the payload the command rebuilds from the issue, with the nonce that travels in the confirmation.
    expect(signed[0]?.['payloadSha256']).toBe(statusPayload(issue as never, 'closed', 'tray moved', params.confirmation.nonce));
    vi.unstubAllGlobals();
  });

  it('opens the signing dialog to delete an issue and dispatches nothing until signed', () => {
    render(<ReviewPanel />);
    fireEvent.click(within(openIssue()).getByLabelText('Delete issue iss-2'));
    expect(screen.getByTestId('sign-summary')).toHaveTextContent('Deleting an issue is a human act');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('finds clashes into issues through the command', () => {
    render(<ReviewPanel />);
    fireEvent.change(screen.getByLabelText('Clash source'), { target: { value: 'check_assembly' } });
    fireEvent.click(screen.getByText('Issues from clashes'));
    expect(dispatch).toHaveBeenCalledWith(
      'create_clash_issues',
      { source: 'check_assembly' },
      expect.objectContaining({ onResult: expect.any(Function) }),
    );
  });

  it('imports a picked BCF file as base64 through import_bcf', async () => {
    render(<ReviewPanel />);
    const bytes = new Uint8Array([80, 75, 3, 4]);
    const file = new File([bytes], 'review.bcf');
    Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.resolve(bytes.buffer) });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('BCF file to import'), { target: { files: [file] } });
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    expect(dispatch).toHaveBeenCalledWith('import_bcf', { bcf: btoa(String.fromCharCode(80, 75, 3, 4)) }, expect.anything());
  });
});

describe('Review panel: viewpoints, redlines, section box, colour', () => {
  it('saves the live camera as a viewpoint', () => {
    render(<ReviewPanel />);
    fireEvent.change(screen.getByLabelText('Viewpoint name'), { target: { value: 'Overview' } });
    fireEvent.click(screen.getByText('Save view'));
    expect(dispatch).toHaveBeenCalledWith('save_viewpoint', {
      name: 'Overview',
      camera: { projection: 'perspective', eye: [5, 10, 15], direction: [-5, -10, -15], up: [0, 0, 1] },
    });
  });

  it('arms a redline tool only once a viewpoint is chosen', () => {
    render(<ReviewPanel />);
    const line = screen.getByText('Line');
    expect(line).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Go to Pump skid'));
    expect(dispatch).toHaveBeenCalledWith('apply_viewpoint', { id: 'vp-1' });
    fireEvent.click(line);
    expect(useRedlineStore.getState().tool).toBe('line');
  });

  it('creates a section box around the model through set_section_box', () => {
    render(<ReviewPanel />);
    fireEvent.click(screen.getByText(/Section box around model/));
    const [name, params] = dispatch.mock.calls[0] as [string, { min: number[]; max: number[]; activate: boolean }];
    expect(name).toBe('set_section_box');
    expect(params.activate).toBe(true);
    expect(params.min[0]).toBeLessThan(-1);
    expect(params.max[0]).toBeGreaterThan(1);
  });

  it('switches section clipping off through set_active_section_box, only while a box is active', () => {
    const { unmount } = render(<ReviewPanel />);
    expect(screen.queryByText('Clip off')).toBeNull();
    unmount();
    const doc = execute(useStore.getState().document, 'set_section_box', {
      name: 'Box',
      min: [0, 0, 0],
      max: [1, 1, 1],
      activate: true,
    }).document;
    useStore.setState({ document: doc });
    render(<ReviewPanel />);
    fireEvent.click(screen.getByText('Clip off'));
    expect(dispatch).toHaveBeenCalledWith('set_active_section_box', { id: null });
  });

  it('switches the colour profile through set_active_colour_profile', () => {
    const doc = execute(useStore.getState().document, 'define_colour_profile', {
      id: 'p1',
      name: 'By kind',
      rules: [{ id: 'r1', when: { property: 'kind', equals: 'box' }, colour: '#ff0000', legend: 'Boxes' }],
    }).document;
    useStore.setState({ document: doc });
    render(<ReviewPanel />);
    fireEvent.change(screen.getByLabelText('Colour profile'), { target: { value: 'p1' } });
    expect(dispatch).toHaveBeenCalledWith('set_active_colour_profile', { profileId: 'p1' });
  });
});

describe('MarkupOverlay', () => {
  const rect = { left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) };
  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect as DOMRect);
  });

  it('draws nothing without a viewpoint or tool', () => {
    const { container } = render(<MarkupOverlay />);
    expect(container).toBeEmptyDOMElement();
  });

  it('turns a drag into one add_markup in normalised screen points', () => {
    useRedlineStore.setState({ viewpointId: 'vp-1', tool: 'line', colour: '#e03030' });
    render(<MarkupOverlay />);
    const surface = screen.getByTestId('redline-surface');
    fireEvent.pointerDown(surface, { clientX: 20, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 100, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(surface, { clientX: 100, clientY: 50, pointerId: 1 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith('add_markup', {
      viewpointId: 'vp-1',
      shape: 'line',
      space: 'screen',
      points: [
        [0.1, 0.1],
        [0.5, 0.5],
      ],
      colour: '#e03030',
      author: 'human',
    });
  });

  it('a cloud drag sends the four corners; a click-sized drag sends nothing', () => {
    useRedlineStore.setState({ viewpointId: 'vp-1', tool: 'cloud' });
    render(<MarkupOverlay />);
    const surface = screen.getByTestId('redline-surface');
    fireEvent.pointerDown(surface, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(surface, { clientX: 0.5, clientY: 0.5, pointerId: 1 });
    expect(dispatch).not.toHaveBeenCalled();
    fireEvent.pointerDown(surface, { clientX: 20, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(surface, { clientX: 100, clientY: 50, pointerId: 1 });
    expect((dispatch.mock.calls[0]?.[1] as { points: unknown[] }).points).toHaveLength(4);
  });

  it('a text note takes its words from an inline field and sends one anchor point', () => {
    useRedlineStore.setState({ viewpointId: 'vp-1', tool: 'text' });
    render(<MarkupOverlay />);
    fireEvent.pointerDown(screen.getByTestId('redline-surface'), { clientX: 100, clientY: 50, pointerId: 1 });
    const input = screen.getByLabelText('Redline text');
    fireEvent.change(input, { target: { value: 'Move this' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(dispatch).toHaveBeenCalledWith(
      'add_markup',
      expect.objectContaining({ shape: 'text', points: [[0.5, 0.5]], text: 'Move this' }),
    );
  });

  it('shows the markups of the viewpoint from the document', () => {
    const first = execute(useStore.getState().document, 'add_markup', {
      viewpointId: 'vp-1',
      shape: 'line',
      space: 'screen',
      points: [
        [0, 0],
        [1, 1],
      ],
      colour: '#112233',
    }).document;
    const doc = execute(first, 'add_markup', {
      viewpointId: 'vp-1',
      shape: 'text',
      space: 'screen',
      points: [[0.5, 0.5]],
      colour: '#112233',
      text: 'Look here',
    }).document;
    useStore.setState({ document: doc });
    useRedlineStore.setState({ viewpointId: 'vp-1', tool: null });
    const { container } = render(<MarkupOverlay />);
    expect(container.querySelectorAll('polyline')).toHaveLength(1);
    expect(container.querySelector('text')).toHaveTextContent('Look here');
  });
});

describe('Review panel: stale signatures and unverified authors', () => {
  const realDispatch = (
    name: string,
    params?: unknown,
    options?: { onResult?: (r: { summary: string; changed: boolean }) => void },
  ): void => {
    const before = useStore.getState().document;
    const result = execute(before, name, params, humanCtx());
    useStore.setState({ document: result.document });
    options?.onResult?.({ summary: result.summary, changed: result.document !== before });
  };

  it('a signature over a stale issue is refused: the summary is shown and the status is unchanged', async () => {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/signing/keys'))
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [{ keyId: 'k-1', userId: 'u-1', name: 'J. Example', trusted: true }] }), { status: 200 }),
        );
      const body = JSON.parse(String(init?.body)) as { payloadSha256: string };
      return Promise.resolve(
        new Response(
          JSON.stringify({ signature: { alg: 'Ed25519', keyId: 'k-1', publicKey: 'a'.repeat(64), signature: body.payloadSha256 } }),
          { status: 200 },
        ),
      );
    });
    useStore.setState({ dispatch: realDispatch as never });
    render(<ReviewPanel />);
    const detail = openIssue();
    fireEvent.change(within(detail).getByLabelText('Move iss-2 to'), { target: { value: 'closed' } });
    fireEvent.change(within(detail).getByLabelText('Reason for moving iss-2'), { target: { value: 'done' } });
    fireEvent.click(within(detail).getByText('Sign and move'));
    await screen.findByText(/J. Example/);
    // the issue changes while the dialog is open
    act(() => {
      const moved = execute(useStore.getState().document, 'set_issue_status', {
        issueId: 'iss-2',
        status: 'in_progress',
        reason: 'meanwhile',
      });
      useStore.setState({ document: moved.document });
    });
    fireEvent.change(screen.getByTestId('sign-passphrase'), { target: { value: 'a long passphrase' } });
    fireEvent.click(screen.getByTestId('sign-confirm'));
    const notice = await screen.findByTestId('issue-notice');
    expect(notice).toHaveTextContent(/rejected|human act|did not verify/i);
    expect(useStore.getState().document.review?.issues['iss-2']?.status).toBe('in_progress');
    vi.unstubAllGlobals();
  });

  it('an unsigned human comment is a label only: check_review is unchanged', () => {
    const doc = useStore.getState().document;
    const before = execute(doc, 'check_review', {}, humanCtx()).data;
    const after = execute(
      execute(doc, 'add_review_comment', { issueId: 'iss-2', text: 'I approve this', author: 'human' }).document,
      'check_review',
      {},
      humanCtx(),
    ).data;
    // The comment count rises; no finding, status or issue count moves.
    const verdict = (data: unknown): unknown => {
      const { status, issues, counts } = data as { status: string; issues: unknown; counts: { issues: unknown } };
      return { status, issues, issueCounts: counts.issues };
    };
    expect(verdict(after)).toEqual(verdict(before));
  });
});
