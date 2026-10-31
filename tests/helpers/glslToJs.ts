/**
 * A CPU twin of the emitted GLSL of `compileFieldToGlsl` (05 IMP 14.x): the text of the shader is rewritten into JavaScript line by line (types
 * dropped, `uC[i].x` read from the uniform array) and run, so the emitted code itself, not only the compiler, is checked against the TS interpreter.
 * Only the subset the compiler emits is handled: scalar `float` locals, helper functions, ternaries, `if (...) return`, and the GLSL builtins used.
 */

const PRELUDE = 'const { sin, cos, abs, min, max, sqrt, floor, exp, log } = Math; const atan = (y, x) => Math.atan2(y, x);\n';

export type ScalarField = (x: number, y: number, z: number) => number;

/** The `fieldAt` function of `source`, reading `constants` as the contents of `uC`. */
export function glslToJs(source: string, constants: readonly number[]): ScalarField {
  const code = source
    .replace(/uniform vec4 uC\[\d+\];/, '')
    .replace(/^float (\w+)\(([^)]*)\) \{/gm, (_whole, name: string, params: string) => {
      const names = params.split(',').map((part) => part.trim().replace(/^float /, ''));
      return `function ${name}(${names.join(', ')}) {`;
    })
    .replace(/^(\s+)float (\w+) =/gm, '$1let $2 =');
  const slots = Array.from({ length: constants.length / 4 }, (_, i) => ({
    x: constants[4 * i] as number,
    y: constants[4 * i + 1] as number,
    z: constants[4 * i + 2] as number,
    w: constants[4 * i + 3] as number,
  }));
  return new Function('uC', `${PRELUDE}${code}\nreturn fieldAt;`)(slots) as ScalarField;
}
