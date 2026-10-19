import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { documentHash } from '@protocol/liveSync';
import { useStore } from '@ui/store';
import { useLiveFxStore } from '@ui/store/liveFxStore';
import { consumeLiveOrigin, isOwnCommandId, markLiveOrigin } from '@ui/store/liveOrigin';
import { newCommandId } from '@ui/store/outbox';
import { useMcpLiveDocument } from '@ui/hooks/useMcpLiveDocument';
import { useLiveFx } from '@ui/hooks/useLiveFx';
import { LiveActivityFeed } from '@ui/components/LiveActivityFeed';
import { planLiveFx } from '@ui/viewport/liveFx/planLiveFx';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (e: Event) => void>();
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (e: Event) => void): void {
    this.listeners.set(type, listener);
  }
  close(): void {}
  emit(type: string, payload: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(payload) } as unknown as Event);
  }
}

function Harness(): React.ReactElement {
  useMcpLiveDocument();
  useLiveFx();
  return <LiveActivityFeed />;
}

const BOX = { size: [1, 1, 1] };

function resetLiveFx(): void {
  useLiveFxStore.setState({ enabled: true, transitions: new Map(), ghosts: [], ripples: [], badges: [], activity: [], focus: null });
}

describe('live-edit effects', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    useStore.setState({
      document: createEmptyDocument(),
      liveBase: createEmptyDocument(),
      liveSeq: -1,
      liveEpoch: null,
      hasUnsyncedLocalEdits: false,
    });
    resetLiveFx();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function connectWithSnapshot(): FakeEventSource {
    const source = FakeEventSource.instances[0]!;
    const document = createEmptyDocument();
    act(() => source.emit('snapshot', { epoch: 'e', seq: 0, stateHash: documentHash(document), document }));
    return source;
  }

  function commandEvent(extra: Record<string, unknown>): Record<string, unknown> {
    const after = execute(useStore.getState().liveBase, 'add_box', BOX).document;
    return { epoch: 'e', seq: useStore.getState().liveSeq + 1, name: 'add_box', params: BOX, stateHash: documentHash(after), ...extra };
  }

  it('animates a CLI command and lists it in the activity feed', () => {
    render(<Harness />);
    const source = connectWithSnapshot();
    act(() => source.emit('command', commandEvent({ source: 'cli' })));
    const state = useLiveFxStore.getState();
    expect(state.transitions.size).toBe(1);
    expect(state.badges[0]?.label).toBe('CLI · add_box');
    expect(screen.getByText('add_box')).toBeTruthy();
    expect(screen.getByText('+1')).toBeTruthy();
  });

  it("treats the echo of this client's own command as local (no badge, no feed row)", () => {
    render(<Harness />);
    const source = connectWithSnapshot();
    const commandId = newCommandId();
    expect(isOwnCommandId(commandId)).toBe(true);
    act(() => source.emit('command', commandEvent({ source: 'rest', commandId })));
    const state = useLiveFxStore.getState();
    expect(state.transitions.get(Object.keys(useStore.getState().document.entities)[0]!)?.tone).toBe('local');
    expect(state.badges).toHaveLength(0);
    expect(state.activity).toHaveLength(0);
  });

  it('turns animations off from the feed but keeps listing remote edits', () => {
    render(<Harness />);
    const source = connectWithSnapshot();
    act(() => source.emit('command', commandEvent({ source: 'mcp' })));
    fireEvent.click(screen.getByRole('button', { name: /FX on/ }));
    expect(useLiveFxStore.getState().transitions.size).toBe(0);
    act(() => source.emit('command', commandEvent({ source: 'mcp' })));
    expect(useLiveFxStore.getState().transitions.size).toBe(0);
    expect(screen.getAllByText('MCP agent')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /FX off/ }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('liveFxStore', () => {
  beforeEach(resetLiveFx);

  it('prunes finished effects and leaves running ones untouched', () => {
    const empty = createEmptyDocument();
    const result = execute(empty, 'add_box', BOX);
    const removed = execute(result.document, 'delete_entities', { ids: result.affected });
    const store = useLiveFxStore.getState();
    store.apply(planLiveFx(empty, result.document, { kind: 'remote', name: 'add_box', source: 'mcp' }, 0, 1));
    store.apply(planLiveFx(result.document, removed.document, { kind: 'local' }, 0, 2));
    let state = useLiveFxStore.getState();
    expect(state.transitions.size).toBe(0); // the removal ghost replaced the creation transition
    expect(state.ghosts).toHaveLength(1);
    expect(state.focus?.nonce).toBe(1);
    state.prune(100);
    expect(useLiveFxStore.getState()).toBe(state);
    useLiveFxStore.getState().prune(1e9);
    state = useLiveFxStore.getState();
    expect([state.ghosts.length, state.ripples.length, state.badges.length, state.activity.length]).toEqual([0, 0, 0, 0]);
  });
});

describe('liveFxStore — merging', () => {
  beforeEach(resetLiveFx);

  it('keeps a running grow when the new entity is edited right away, and skips no-op plans', () => {
    const empty = createEmptyDocument();
    const created = execute(empty, 'add_box', BOX);
    const id = created.affected[0]!;
    const moved = execute(created.document, 'move_entities', { ids: [id], delta: [1, 0, 0] });
    const origin = { kind: 'remote', name: 'x', source: 'cli' } as const;
    useLiveFxStore.getState().apply(planLiveFx(empty, created.document, origin, 0, 1));
    useLiveFxStore.getState().apply(planLiveFx(created.document, moved.document, origin, 100, 2));
    expect(useLiveFxStore.getState().transitions.get(id)?.change).toBe('created');
    const before = useLiveFxStore.getState();
    useLiveFxStore.getState().apply(planLiveFx(moved.document, moved.document, origin, 200, 3));
    expect(useLiveFxStore.getState()).toBe(before);
  });
});

describe('liveOrigin', () => {
  it('hands out a marked origin once, then defaults to local', () => {
    markLiveOrigin({ kind: 'snapshot' });
    expect(consumeLiveOrigin()).toEqual({ kind: 'snapshot' });
    expect(consumeLiveOrigin()).toEqual({ kind: 'local' });
    expect(isOwnCommandId(undefined)).toBe(false);
  });
});
