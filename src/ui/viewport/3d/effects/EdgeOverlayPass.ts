// Feature-edge pass (screen space). The scene is drawn once more with a normal material into a target with a depth texture; a Roberts-cross on
// the view-space normals and the linear depth marks creases, silhouettes and contact lines, drawn dark over the beauty image. Cost is one extra
// scene render plus one full-screen quad whatever the instance count (plant batches stay instanced; no per-prototype edge geometry), and the
// renderer's global clipping planes cut the normal render too, so a section clips the edges with the surface.
// Selection outline: while something is selected, the selection layer alone is drawn flat into a mask; the mask's outer rim is drawn in the
// selection colour over everything (no depth test: the outline of a part hidden behind another still shows where it is).

import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import type { DepthRangeCamera } from './depthRangeCamera';
import { hideEdgeExcluded } from './edgeExclusion';
import { SELECTION_LAYER } from './selectionLayer';
import { SELECTION_COLOR } from '../../viewportPalette';

const EDGE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tNormal: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    texel: { value: new THREE.Vector2(1, 1) },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 1000 },
    lineColor: { value: new THREE.Color('#10131a') },
    strength: { value: 0.62 },
    tMask: { value: null as THREE.Texture | null },
    selectionColor: { value: new THREE.Color(SELECTION_COLOR) },
    /** 0 = nothing selected (the mask is not sampled), 1 = draw the outline. */
    selection: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tNormal;
    uniform sampler2D tDepth;
    uniform vec2 texel;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform vec3 lineColor;
    uniform float strength;
    uniform sampler2D tMask;
    uniform vec3 selectionColor;
    uniform float selection;
    varying vec2 vUv;

    // Coverage of the selection within ~2.5 texels: the mask dilated, so (dilated - mask) is a rim just outside the silhouette.
    float dilatedMask(vec2 uv) {
      float m = 0.0;
      for (int i = 0; i < 8; i++) {
        float angle = 0.7853981634 * float(i);
        vec2 dir = vec2(cos(angle), sin(angle)) * texel;
        m = max(m, texture2D(tMask, uv + dir * 2.5).r);
        m = max(m, texture2D(tMask, uv + dir * 1.25).r);
      }
      return m;
    }

    float viewDepth(vec2 uv) {
      float d = texture2D(tDepth, uv).x;
      if (d >= 1.0) return cameraFar;
      return (cameraNear * cameraFar) / (cameraFar - d * (cameraFar - cameraNear));
    }
    vec3 viewNormal(vec2 uv) { return texture2D(tNormal, uv).xyz * 2.0 - 1.0; }

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec2 a = vUv + vec2(-texel.x, -texel.y);
      vec2 b = vUv + vec2(texel.x, texel.y);
      vec2 c = vUv + vec2(-texel.x, texel.y);
      vec2 d = vUv + vec2(texel.x, -texel.y);
      float z0 = viewDepth(a);
      float z1 = viewDepth(b);
      float z2 = viewDepth(c);
      float z3 = viewDepth(d);
      float zc = viewDepth(vUv);
      // Depth jump relative to the depth itself, forgiven on surfaces seen at a grazing angle (their depth slopes steeply).
      float depthEdge = max(abs(z0 - z1), abs(z2 - z3)) / max(min(min(z0, z1), min(z2, z3)), 1e-4);
      float grazing = 1.0 - abs(viewNormal(vUv).z);
      float tolerance = 1.0 + 8.0 * grazing * grazing;
      depthEdge = smoothstep(0.015 * tolerance, 0.045 * tolerance, depthEdge);
      vec3 n0 = viewNormal(a);
      vec3 n1 = viewNormal(b);
      vec3 n2 = viewNormal(c);
      vec3 n3 = viewNormal(d);
      float normalEdge = max(1.0 - dot(n0, n1), 1.0 - dot(n2, n3));
      normalEdge = smoothstep(0.12, 0.35, normalEdge);
      // The normal target is cleared to zero: no surface there, the depth edge already draws the silhouette.
      if (zc >= cameraFar && z0 >= cameraFar && z1 >= cameraFar && z2 >= cameraFar && z3 >= cameraFar) normalEdge = 0.0;
      float edge = max(depthEdge, normalEdge) * strength;
      vec4 color = vec4(mix(base.rgb, lineColor, edge), max(base.a, edge));
      if (selection > 0.5) {
        float inside = texture2D(tMask, vUv).r;
        float rim = clamp(dilatedMask(vUv) - inside, 0.0, 1.0);
        color.rgb = mix(color.rgb, selectionColor, max(rim, inside * 0.07));
        color.a = max(color.a, rim);
      }
      gl_FragColor = color;
    }
  `,
};

export class EdgeOverlayPass extends Pass {
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;
  private readonly normalMaterial = new THREE.MeshNormalMaterial();
  private readonly maskMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  private readonly target: THREE.WebGLRenderTarget;
  private readonly mask: THREE.WebGLRenderTarget;
  private readonly clearColor = new THREE.Color();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly depthCamera: DepthRangeCamera,
    width: number,
    height: number,
    /** True while something is selected: the mask render is skipped otherwise. */
    private readonly hasSelection: () => boolean = () => false,
  ) {
    super();
    this.mask = new THREE.WebGLRenderTarget(width, height, { samples: 4, depthBuffer: false });
    this.target = new THREE.WebGLRenderTarget(width, height, { depthTexture: new THREE.DepthTexture(width, height) });
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(EDGE_SHADER.uniforms),
      vertexShader: EDGE_SHADER.vertexShader,
      fragmentShader: EDGE_SHADER.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
    this.setSize(width, height);
  }

  override setSize(width: number, height: number): void {
    this.target.setSize(width, height);
    this.mask.setSize(width, height);
    this.material.uniforms['texel']?.value.set(1 / width, 1 / height);
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const previousTarget = renderer.getRenderTarget();
    const previousAlpha = renderer.getClearAlpha();
    const previousAutoClear = renderer.autoClear;
    const previousBackground = this.scene.background;
    renderer.getClearColor(this.clearColor);

    const camera = this.depthCamera.current();
    const restoreVisibility = hideEdgeExcluded(this.scene);
    this.scene.overrideMaterial = this.normalMaterial;
    this.scene.background = null;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x808080, 0);
    renderer.autoClear = true;
    renderer.render(this.scene, camera);
    const selection = this.hasSelection();
    if (selection) this.renderSelectionMask(renderer, camera);
    this.scene.overrideMaterial = null;
    this.scene.background = previousBackground;
    restoreVisibility();
    renderer.setClearColor(this.clearColor, previousAlpha);
    renderer.autoClear = previousAutoClear;

    const uniforms = this.material.uniforms as Record<string, THREE.IUniform>;
    uniforms['tDiffuse']!.value = readBuffer.texture;
    uniforms['tNormal']!.value = this.target.texture;
    uniforms['tDepth']!.value = this.target.depthTexture;
    uniforms['tMask']!.value = this.mask.texture;
    uniforms['selection']!.value = selection ? 1 : 0;
    uniforms['cameraNear']!.value = camera.near;
    uniforms['cameraFar']!.value = camera.far;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
    renderer.setRenderTarget(previousTarget);
  }

  /** The selection layer alone, flat white on black. The camera's own layers are put back (it may be the view camera). */
  private renderSelectionMask(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    const layers = camera.layers.mask;
    camera.layers.set(SELECTION_LAYER);
    this.scene.overrideMaterial = this.maskMaterial;
    renderer.setRenderTarget(this.mask);
    renderer.setClearColor(0x000000, 0);
    renderer.render(this.scene, camera);
    camera.layers.mask = layers;
  }

  override dispose(): void {
    this.mask.dispose();
    this.maskMaterial.dispose();
    this.target.dispose();
    this.target.depthTexture?.dispose();
    this.material.dispose();
    this.normalMaterial.dispose();
    this.quad.dispose();
  }
}
