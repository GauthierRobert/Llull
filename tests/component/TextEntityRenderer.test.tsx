/**
 * Component tests for VT1 — TextEntity render branches (3D TextMesh + 2D TextRenderer2D).
 *
 * Since jsdom cannot run WebGL (no Canvas / THREE.WebGLRenderer), we test the
 * observable behavior through the store:
 *   1. add_text produces a 'text' entity with correct content and fontSize (height).
 *   2. text entity is in document.order (i.e., the EntityRenderer switch has a branch
 *      for it — returning null would not prevent insertion, but the kind must be present).
 *   3. Selection test: selecting a text entity id updates document.selection.
 *   4. Anchor test: add_text with anchor:'center' stores entity.anchor === 'center'.
 *   5. Empty content: add_text with empty content is a no-op (graceful guard in command).
 *
 * The TextMesh and TextRenderer2D components themselves use drei <Text> (WebGL/SDF),
 * which cannot be rendered in jsdom; we validate the render-branch wiring by confirming
 * the entity shape the command produces matches what the components expect (R11: assert
 * observable behavior, not internals).
 *
 * @layer tests/component
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import type { TextEntity } from '@core/model/types';
import { localDispatch } from '../helpers/storeTestHelpers';

function resetStore(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
}

// ---------------------------------------------------------------------------
// 1. Basic render shape — content and fontSize (height)
// ---------------------------------------------------------------------------

describe('TextEntity — add_text produces correct entity shape', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('creates a text entity with kind "text"', () => {
    const result = localDispatch('add_text', {
      content: 'Hello world',
      position: [0, 0, 0],
      height: 1.5,
    });
    expect(result.affected).toHaveLength(1);

    const id = result.affected[0]!;
    const entity = useStore.getState().document.entities[id];
    expect(entity).toBeDefined();
    expect(entity?.kind).toBe('text');
  });

  it('content string matches the drei <Text> children prop input', () => {
    const result = localDispatch('add_text', {
      content: 'Label A',
      position: [1, 2, 0],
      height: 0.5,
    });
    const id = result.affected[0]!;
    const entity = useStore.getState().document.entities[id] as TextEntity;
    // TextMesh passes entity.content as children to drei <Text>
    expect(entity.content).toBe('Label A');
  });

  it('fontSize (height) matches entity.height used in TextMesh fontSize prop', () => {
    const result = localDispatch('add_text', {
      content: 'Height test',
      position: [0, 0, 0],
      height: 2.5,
    });
    const id = result.affected[0]!;
    const entity = useStore.getState().document.entities[id] as TextEntity;
    // TextMesh sets fontSize={entity.height}; verify the stored height matches
    expect(entity.height).toBe(2.5);
  });

  it('text entity appears in document.order', () => {
    const result = localDispatch('add_text', {
      content: 'Order test',
      position: [0, 0, 0],
      height: 1,
    });
    const id = result.affected[0]!;
    expect(useStore.getState().document.order).toContain(id);
  });
});

// ---------------------------------------------------------------------------
// 2. Selection — selecting a text entity id updates document.selection
// ---------------------------------------------------------------------------

describe('TextEntity — selection dispatches correctly', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('select([id]) for a text entity updates document.selection', () => {
    const result = localDispatch('add_text', {
      content: 'Selectable',
      position: [0, 0, 0],
      height: 1,
    });
    const id = result.affected[0]!;

    // Simulate what TextMesh.handleClick does (calls onSelect → store.select([id]))
    useStore.getState().select([id]);

    expect(useStore.getState().document.selection).toContain(id);
  });
});

// ---------------------------------------------------------------------------
// 3. Anchor — anchor:'center' propagates to entity.anchor
// ---------------------------------------------------------------------------

describe('TextEntity — anchor prop', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('anchor:"center" stores entity.anchor === "center" (maps to anchorX="center" in drei)', () => {
    const result = localDispatch('add_text', {
      content: 'Centered text',
      position: [5, 5, 0],
      height: 1,
      anchor: 'center',
    });
    const id = result.affected[0]!;
    const entity = useStore.getState().document.entities[id] as TextEntity;
    // TextMesh and TextRenderer2D read entity.anchor and pass it as anchorX
    expect(entity.anchor).toBe('center');
  });

  it('anchor:"right" stores entity.anchor === "right"', () => {
    const result = localDispatch('add_text', {
      content: 'Right-aligned',
      position: [3, 3, 0],
      height: 1,
      anchor: 'right',
    });
    const id = result.affected[0]!;
    const entity = useStore.getState().document.entities[id] as TextEntity;
    expect(entity.anchor).toBe('right');
  });

  it('anchor defaults to "left" when not specified', () => {
    const result = localDispatch('add_text', {
      content: 'Default anchor',
      position: [0, 0, 0],
      height: 1,
    });
    const id = result.affected[0]!;
    const entity = useStore.getState().document.entities[id] as TextEntity;
    // Default anchor is 'left' (see annotate.ts run() default)
    expect(entity.anchor).toBe('left');
  });
});

// ---------------------------------------------------------------------------
// 4. Empty content — defensive: add_text with empty content is a graceful no-op
// ---------------------------------------------------------------------------

describe('TextEntity — empty content guard', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('add_text with empty content returns no-op (affected: [])', () => {
    const result = localDispatch('add_text', {
      content: '',
      position: [0, 0, 0],
      height: 1,
    });
    // The command guards: empty content → no entity created
    expect(result.affected).toHaveLength(0);
    expect(useStore.getState().document.order).toHaveLength(0);
  });

  it('add_text with whitespace-only content is also a no-op', () => {
    const result = localDispatch('add_text', {
      content: '   ',
      position: [0, 0, 0],
      height: 1,
    });
    expect(result.affected).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Grouping / instancing — text is NOT batchable (falls to per-entity path)
// ---------------------------------------------------------------------------

describe('TextEntity — not routed through instanced renderer', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('isBatchable returns false for a text entity', async () => {
    // Import grouping after test infra is ready.
    const { isBatchable } = await import('../../src/ui/viewport/3d/grouping');

    const result = localDispatch('add_text', {
      content: 'Batch check',
      position: [0, 0, 0],
      height: 1,
    });
    const id = result.affected[0]!;
    const entity = useStore.getState().document.entities[id]!;
    expect(isBatchable(entity)).toBe(false);
  });
});
