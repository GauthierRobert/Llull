// 05 IMP 14.x GPU preview (UI): the toolbar switch changes no document, the answer of implicit_gpu_program is parsed strictly, the shader text carries the generated field,
// the overlay draws one group per selected implicit body, and a body with no GPU path stays on the mesh and is named.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { execute } from '@core/commands/registry';
import { useStore } from '@ui/store';
import { useImplicitPreviewStore } from '@ui/store/implicitPreviewStore';
import { ImplicitPreviewControl, ImplicitPreviewNote } from '@ui/viewport/3d/implicitPreview/ImplicitPreviewControl';
import { ImplicitGpuPreview, MAX_GPU_BODIES } from '@ui/viewport/3d/implicitPreview/ImplicitGpuPreview';
import { MAX_MARCH_STEPS, STEP_SAFETY, fragmentShader, parseGpuAnswer } from '@ui/viewport/3d/implicitPreview/gpuProgram';
import { resetOfflineStore } from '../helpers/storeTestHelpers';

vi.mock('@react-three/fiber', () => ({
  useThree: (select: (state: unknown) => unknown) =>
    select({ camera: { position: { copy: () => ({ applyMatrix4: () => undefined }) } }, size: { height: 600 } }),
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
    expect(shader).toContain('t += max(f * uStepScale');
    expect(STEP_SAFETY.exact).toBe(1);
    expect(STEP_SAFETY.approximate).toBeLessThan(STEP_SAFETY.bound);
    expect(STEP_SAFETY.bound).toBeLessThan(1);
  });
});
