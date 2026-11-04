// OutputPass that composites over the scene background. The Canvas draws `scene.background` as a clear colour, which tone mapping never
// touches; inside the composer the same clear colour would go through ACES and come out grey. So the composer renders with a transparent
// background (alpha = coverage), and this pass tone-maps / converts the premultiplied colour and puts the background behind it afterwards,
// which keeps the High tier's background identical to Standard's.

import * as THREE from 'three';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { OutputShader } from 'three/examples/jsm/shaders/OutputShader.js';

const UNPREMULTIPLY =
  'vec4 covered = texture2D( tDiffuse, vUv ); float cover = clamp( covered.a, 0.0, 1.0 );\n' +
  'gl_FragColor = vec4( cover > 0.0 ? covered.rgb / cover : vec3( 0.0 ), cover );';

/** The fragment shader of three's OutputShader with the background composited after tone mapping and the sRGB transfer. */
export function backgroundOutputFragment(source: string = OutputShader.fragmentShader): string {
  const end = source.lastIndexOf('}');
  const body = source
    .slice(0, end)
    .replace('uniform sampler2D tDiffuse;', 'uniform sampler2D tDiffuse;\nuniform vec3 backgroundColor;')
    .replace('gl_FragColor = texture2D( tDiffuse, vUv );', UNPREMULTIPLY);
  return `${body}\ngl_FragColor = vec4( mix( backgroundColor, gl_FragColor.rgb, cover ), 1.0 );\n}`;
}

const scratch = new THREE.Color();
const clearScratch = new THREE.Color();

/** The colour behind the image: the scene background when it is a plain colour, else the renderer's own clear colour (never a made-up white). */
export function pickBackground(background: unknown, clearColour: THREE.Color): THREE.Color {
  return background instanceof THREE.Color ? background : clearColour;
}

export class BackgroundOutputPass extends OutputPass {
  /** `background` is the scene's background as it was before the composer cleared it (any type). */
  constructor(private readonly background: () => unknown) {
    super();
    this.material.fragmentShader = backgroundOutputFragment();
    this.uniforms['backgroundColor'] = { value: new THREE.Color(1, 1, 1) };
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean,
  ): void {
    const colour = pickBackground(this.background(), renderer.getClearColor(clearScratch));
    (this.uniforms['backgroundColor']?.value as THREE.Color).setRGB(...srgb(colour));
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }
}

/** The colour as the sRGB values the screen shows. */
export function srgb(colour: THREE.Color): [number, number, number] {
  scratch.copy(colour).convertLinearToSRGB();
  return [scratch.r, scratch.g, scratch.b];
}
