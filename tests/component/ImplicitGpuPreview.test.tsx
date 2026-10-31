// 05 IMP 14.x GPU preview (UI): the toolbar switch changes no document, the answer of implicit_gpu_program is parsed strictly, the shader text carries the generated field,
// the overlay draws one group per selected implicit body, and a body with no GPU path stays on the mesh and is named.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { execute } from '@core/commands/registry';
import { useStore } from '@ui/store';
import { useImplicitPreviewStore } from '@ui/store/implicitPreviewStore';
import { ImplicitPreviewControl, ImplicitPreviewNote } from '@ui/viewport/3d/implicitPreview/ImplicitPreviewControl';
import { ImplicitGpuPreview, MAX_GPU_BODIES } from '@ui/viewport/3d/implicitPreview/ImplicitGpuPreview';
import {
  MAX_CLIP_PLANES,
  MAX_MARCH_STEPS,
  REFINE_STEPS,
  STEP_SAFETY,
  fragmentShader,
  parseGpuAnswer,
} from '@ui/viewport/3d/implicitPreview/gpuProgram';
import { resetOfflineStore } from '../helpers/storeTestHelpers';

const built = vi.hoisted(() => ({ materials: 0 }));
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class CountingShaderMaterial extends actual.ShaderMaterial {
    constructor(parameters?: ConstructorParameters<typeof actual.ShaderMaterial>[0]) {
      super(parameters);
      built.materials += 1;
    }
  }
  return { ...actual, ShaderMaterial: CountingShaderMaterial };
});

vi.mock('@react-three/fiber', () => ({
  useThree: (select: (state: unknown) => unknown) =>
    select({
      camera: { position: { copy: () => ({ applyMatrix4: () => undefined }) } },
      size: { height: 600 },
      invalidate: () => undefined,
    }),
  useFrame: () => undefined,
}));

function body(op: 'gyroid' | 'struts'): string {
  const run = (name: string, params: Record<string, unknown>): string => {
    const result = execute(useStore.getState().document, name, params);
    expect(result.error, result.summary).toBeUndefined();
    useStore.setState({ document: result.document });
    return result.affected[0] as string;
  };
  const box = run('add_field_primitive', { shape: 'box', size: [8, 8, 8], position: [4, 4, 4] });
  const lattice =
    op === 'gyroid'
      ? run('add_tpms_lattice', { kind: 'gyroid', form: 'network', level: 0, cellSize: 8, origin: [0, 0, 0], region: box })
      : run('add_strut_lattice', { cell: 'bcc', cellSize: 4, radius: 0.3, region: box });
  return run('create_implicit_body', { field: lattice, voxel: 1 });
}

describe('GPU preview control and overlay', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    resetOfflineStore();
    useImplicitPreviewStore.setState({ enabled: false, fallbacks: {} });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('the switch toggles the preview without touching the document', () => {
    render(<ImplicitPreviewControl />);
    const before = JSON.stringify(useStore.getState().document);
    const button = screen.getByLabelText('GPU preview of implicit bodies');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(useImplicitPreviewStore.getState().enabled).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(useImplicitPreviewStore.getState().enabled).toBe(false);
    expect(JSON.stringify(useStore.getState().document)).toBe(before);
  });

  it('draws a group for a selected implicit body only while the switch is on, never for another entity, and not once deselected', () => {
    const id = body('gyroid');
    const plain = execute(useStore.getState().document, 'add_box', { size: [1, 1, 1] });
    useStore.setState({ document: plain.document });
    useStore.getState().select([id, plain.affected[0] as string]);
    const { container } = render(<ImplicitGpuPreview />);
    expect(container.querySelector('group')).toBeNull();
    act(() => useImplicitPreviewStore.getState().setEnabled(true));
    expect(container.querySelector(`group[name="implicit-gpu-${id}"]`)).not.toBeNull();
    expect(container.querySelector(`group[name="implicit-gpu-${plain.affected[0]}"]`)).toBeNull();
    act(() => useStore.getState().clearSelection());
    expect(container.querySelector('group[name^="implicit-gpu-"]:not([name="implicit-gpu-preview"])')).toBeNull();
    expect(MAX_GPU_BODIES).toBe(2);
  });

  it('the body the GPU draws is marked drawn (its mesh is hidden) and forgotten, note and mark, when deselected or when the switch goes off', () => {
    const id = body('gyroid');
    useStore.getState().select([id]);
    useImplicitPreviewStore.setState({ enabled: true });
    render(<ImplicitGpuPreview />);
    expect(useImplicitPreviewStore.getState().drawn[id]).toBe(true);
    act(() => useStore.getState().clearSelection());
    expect(useImplicitPreviewStore.getState().drawn[id]).toBeUndefined();
    expect(useImplicitPreviewStore.getState().fallbacks[id]).toBeUndefined();
    act(() => useStore.getState().select([id]));
    expect(useImplicitPreviewStore.getState().drawn[id]).toBe(true);
    act(() => useImplicitPreviewStore.getState().setEnabled(false));
    expect(useImplicitPreviewStore.getState().drawn[id]).toBeUndefined();
  });

  it('deselecting a body with no GPU path clears its note', () => {
    const struts = body('struts');
    useStore.getState().select([struts]);
    useImplicitPreviewStore.setState({ enabled: true });
    render(
      <>
        <ImplicitGpuPreview />
        <ImplicitPreviewNote />
      </>,
    );
    expect(screen.getByRole('status').textContent).toContain('strut_set');
    act(() => useStore.getState().clearSelection());
    expect(screen.queryByRole('status')).toBeNull();
    expect(useImplicitPreviewStore.getState().drawn[struts]).toBeUndefined();
  });

  it('a parameter drag that keeps the shader key keeps the material (only uniforms change); a structural edit builds a new one', () => {
    const id = body('gyroid');
    const field = (useStore.getState().document as unknown as { implicit: { bodies: Record<string, { field: string }> } }).implicit.bodies[
      id
    ]?.field as string;
    useStore.getState().select([id]);
    useImplicitPreviewStore.setState({ enabled: true });
    built.materials = 0;
    render(<ImplicitGpuPreview />);
    expect(built.materials).toBe(1);
    const edit = execute(useStore.getState().document, 'edit_field', { id: field, changes: { cellSize: 5 } });
    expect(edit.error, edit.summary).toBeUndefined();
    act(() => useStore.setState({ document: edit.document }));
    expect(built.materials).toBe(1);
    const family = execute(useStore.getState().document, 'edit_field', { id: field, changes: { kind: 'diamond' } });
    if (family.error === undefined) {
      act(() => useStore.setState({ document: family.document }));
      expect(built.materials).toBe(2);
    }
  });

  it('a body with no GPU path draws nothing and the note names the blocking op; a body that compiles clears its entry', () => {
    const struts = body('struts');
    useStore.getState().select([struts]);
    useImplicitPreviewStore.setState({ enabled: true });
    const { container } = render(
      <>
        <ImplicitGpuPreview />
        <ImplicitPreviewNote />
      </>,
    );
    expect(container.querySelector(`group[name="implicit-gpu-${struts}"]`)).toBeNull();
    expect(useImplicitPreviewStore.getState().fallbacks[struts]).toEqual(['strut_set']);
    expect(screen.getByRole('status').textContent).toContain('no GPU path for strut_set');
    const gyroid = body('gyroid');
    act(() => useStore.getState().select([gyroid]));
    expect(useImplicitPreviewStore.getState().fallbacks[gyroid]).toEqual([]);
  });
});

describe('implicit_gpu_program answer and shader text', () => {
  const answer = {
    gpu: true,
    glsl: {
      source: 'uniform vec4 uC[1];\nfloat fieldAt(float x, float y, float z) {\n  return x;\n}\n',
      constants: [1, 0, 0, 0],
      key: 'abcd1234',
      lipschitz: 2,
      quality: 'approximate',
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      instructionCount: 3,
      minFeature: 0.5,
    },
  };

  it('parses a valid answer into float32 constants and names an unsupported one; anything else is null', () => {
    const parsed = parseGpuAnswer(answer);
    expect(parsed?.gpu).toBe(true);
    if (parsed?.gpu !== true) throw new Error('gpu expected');
    expect(parsed.program.constants).toBeInstanceOf(Float32Array);
    expect(parsed.program.lipschitz).toBe(2);
    expect(parseGpuAnswer({ gpu: false, unsupported: ['strut_set', 7] })).toEqual({ gpu: false, unsupported: ['strut_set'] });
    for (const bad of [
      null,
      'x',
      { gpu: true },
      { ...answer, glsl: { ...answer.glsl, constants: [1, 2, 3] } },
      { ...answer, glsl: { ...answer.glsl, lipschitz: 0 } },
      { ...answer, glsl: { ...answer.glsl, quality: 'wild' } },
      { ...answer, glsl: { ...answer.glsl, bounds: { min: [0, 0], max: [1, 1, 1] } } },
    ])
      expect(parseGpuAnswer(bad), JSON.stringify(bad).slice(0, 60)).toBeNull();
  });

  it('the fragment shader wraps the generated field with a bounded sphere trace that writes depth and steps conservatively', () => {
    const shader = fragmentShader(answer.glsl.source);
    expect(shader).toContain('float fieldAt(float x, float y, float z)');
    expect(shader).toContain(`i < ${MAX_MARCH_STEPS}`);
    expect(shader).toContain('gl_FragDepth');
    // distances in document units: d = f * uStepScale is a lower bound, a step of d never crosses a sign change, no floor larger than d
    expect(shader).toContain('d = F(ro + rd * t) * uStepScale;');
    expect(shader).toContain('if (d < eps)');
    expect(shader).toContain('t += min(d, uMaxStep);');
    expect(shader.includes('t += max(')).toBe(false);
    expect(shader).toContain(`i < ${REFINE_STEPS}`);
    expect(shader).toContain('#include <tonemapping_fragment>');
    expect(shader).toContain('#include <colorspace_fragment>');
    expect(shader).toContain(`uniform vec4 uClip[${MAX_CLIP_PLANES}]`);
    expect(shader).toContain('clip.z < -clip.w');
    expect(fragmentShader(answer.glsl.source, 'abcd1234')).toContain('// llull-gpu:abcd1234');
    expect(STEP_SAFETY.exact).toBe(1);
    expect(STEP_SAFETY.approximate).toBeLessThan(STEP_SAFETY.bound);
    expect(STEP_SAFETY.bound).toBeLessThan(1);
  });
});
