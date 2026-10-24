/**
 * 3MF Volumetric & Implicit Extensions 1.0.0 writer (05 IMP 6.2, FR-IMP-52): a FieldProgram becomes an `<i:implicitfunction>` of native nodes and the body a
 * `<v:levelset>` object bounded by a box mesh. Namespaces http://schemas.3mf.io/3dmanufacturing/volumetric/2022/01 (v) and .../implicit/2023/12 (i).
 * @invariant the tape is SSA, so the node list has no forward reference (the schema forbids them); every register r is the node `n<r>` with its scalar output
 * @invariant sqrt is written as pow(a, 0.5): the pinned implicit.xsd (sha256 e88ce8d5...) requires two inputs on <sqrt>, against its own documentation
 * @invariant sign convention (open point D7 of the spec): the function is negative inside, as the spec's own mesh and beam-lattice distance nodes are; the 3MF text does not state the interior sign of `<v:levelset>`
 */

import { escapeXml } from '../../lib/escapeXml';
import type { FieldProgram } from '../../geometry/field/program';
import type { Triangle } from '../../geometry/triangles';
import { otherObjectXml } from './threeMfBeamLattice';

export const VOLUMETRIC_NAMESPACE = 'http://schemas.3mf.io/3dmanufacturing/volumetric/2022/01';
export const IMPLICIT_NAMESPACE = 'http://schemas.3mf.io/3dmanufacturing/implicit/2023/12';

export interface ThreeMfLevelSet {
  /** The field in document units. */
  readonly program: FieldProgram;
  /** Object coordinates (millimetres) -> function coordinates (document units) scale. */
  readonly toFunction: number;
  /** Smallest feature to resolve, millimetres. */
  readonly minFeatureSize: number;
  /** Closed box mesh of the evaluation domain, millimetres. */
  readonly domain: readonly Triangle[];
  /** Triangles of each program mesh (`mesh_sdf` operands), in the coordinates the function uses. */
  readonly meshes: ReadonlyArray<readonly Triangle[]>;
}

const num = (value: number): string =>
  Number.isNaN(value) ? 'NaN' : value === Infinity ? 'INF' : value === -Infinity ? '-INF' : String(value);

const scalarRef = (name: string, ref: string): string => `<i:scalarref identifier="${name}" ref="${ref}"/>`;

function node(tag: string, id: string, inputs: ReadonlyArray<readonly [string, string]>, output = 'result', attributes = ''): string {
  return [
    `   <i:${tag} identifier="${id}"${attributes}>`,
    `    <i:in>${inputs.map(([name, ref]) => scalarRef(name, ref)).join('')}</i:in>`,
    `    <i:out><i:scalar identifier="${output}"/></i:out>`,
    `   </i:${tag}>`,
  ].join('\n');
}

const SIMPLE: Readonly<Record<string, string>> = {
  add: 'addition',
  sub: 'subtraction',
  mul: 'multiplication',
  div: 'division',
  min: 'min',
  max: 'max',
  atan2: 'atan2',
};
const UNARY: Readonly<Record<string, string>> = { abs: 'abs', sin: 'sin', cos: 'cos', floor: 'floor', fract: 'fract' };

/** The `<i:implicitfunction>` of `program` with resource id `id`; `meshIds[m]` is the resource id of program mesh m. */
export function implicitFunctionXml(id: number, name: string, program: FieldProgram, meshIds: readonly number[]): string {
  const nodes: string[] = [
    '   <i:decomposevector identifier="dpos">',
    '    <i:in><i:vectorref identifier="A" ref="inputs.pos"/></i:in>',
    '    <i:out><i:scalar identifier="x"/><i:scalar identifier="y"/><i:scalar identifier="z"/></i:out>',
    '   </i:decomposevector>',
    '   <i:constant identifier="zero" value="0"><i:out><i:scalar identifier="value"/></i:out></i:constant>',
    '   <i:constant identifier="half" value="0.5"><i:out><i:scalar identifier="value"/></i:out></i:constant>',
  ];
  const refs: string[] = [];
  const reg = (index: number): string => refs[index] as string;
  program.instructions.forEach((instruction, index) => {
    const id_ = `n${index}`;
    const a = instruction.args.map((arg) => reg(arg));
    const [ra, rb, rc] = [a[0] as string, a[1] as string, a[2] as string];
    refs[index] = `${id_}.result`;
    switch (instruction.op) {
      case 'const':
        refs[index] = `${id_}.value`;
        nodes.push(
          `   <i:constant identifier="${id_}" value="${num(program.constants[instruction.args[0] as number] as number)}"><i:out><i:scalar identifier="value"/></i:out></i:constant>`,
        );
        return;
      case 'x':
      case 'y':
      case 'z':
        refs[index] = `dpos.${instruction.op}`;
        return;
      case 'neg':
        nodes.push(
          node('subtraction', id_, [
            ['A', 'zero.value'],
            ['B', ra],
          ]),
        );
        return;
      case 'sqrt':
        // the pinned implicit.xsd declares two inputs for <sqrt> (upstream defect), so the square root is written as pow(A, 1/2)
        nodes.push(
          node('pow', id_, [
            ['A', ra],
            ['B', 'half.value'],
          ]),
        );
        return;
      case 'square':
        nodes.push(
          node('multiplication', id_, [
            ['A', ra],
            ['B', ra],
          ]),
        );
        return;
      case 'clamp':
        nodes.push(
          node('clamp', id_, [
            ['A', ra],
            ['min', rb],
            ['max', rc],
          ]),
        );
        return;
      case 'select':
        nodes.push(
          node('select', id_, [
            ['A', ra],
            ['B', 'zero.value'],
            ['C', rb],
            ['D', rc],
          ]),
        );
        return;
      case 'smin_quad':
        nodes.push(
          `   <i:constant identifier="${id_}four" value="4"><i:out><i:scalar identifier="value"/></i:out></i:constant>`,
          node('min', `${id_}m`, [
            ['A', ra],
            ['B', rb],
          ]),
          node('subtraction', `${id_}d`, [
            ['A', ra],
            ['B', rb],
          ]),
          node('abs', `${id_}a`, [['A', `${id_}d.result`]]),
          node('subtraction', `${id_}k`, [
            ['A', rc],
            ['B', `${id_}a.result`],
          ]),
          node('max', `${id_}c`, [
            ['A', `${id_}k.result`],
            ['B', 'zero.value'],
          ]),
          node('division', `${id_}h`, [
            ['A', `${id_}c.result`],
            ['B', rc],
          ]),
          node('multiplication', `${id_}q`, [
            ['A', `${id_}h.result`],
            ['B', `${id_}h.result`],
          ]),
          node('multiplication', `${id_}r`, [
            ['A', `${id_}q.result`],
            ['B', rc],
          ]),
          node('division', `${id_}s`, [
            ['A', `${id_}r.result`],
            ['B', `${id_}four.value`],
          ]),
          node('subtraction', `${id_}t`, [
            ['A', `${id_}m.result`],
            ['B', `${id_}s.result`],
          ]),
          node('select', id_, [
            ['A', 'zero.value'],
            ['B', rc],
            ['C', `${id_}t.result`],
            ['D', `${id_}m.result`],
          ]),
        );
        return;
      case 'smin_exp':
        nodes.push(
          `   <i:constant identifier="${id_}one" value="1"><i:out><i:scalar identifier="value"/></i:out></i:constant>`,
          node('min', `${id_}m`, [
            ['A', ra],
            ['B', rb],
          ]),
          node('subtraction', `${id_}d`, [
            ['A', ra],
            ['B', rb],
          ]),
          node('abs', `${id_}a`, [['A', `${id_}d.result`]]),
          node('division', `${id_}q`, [
            ['A', `${id_}a.result`],
            ['B', rc],
          ]),
          node('subtraction', `${id_}n`, [
            ['A', 'zero.value'],
            ['B', `${id_}q.result`],
          ]),
          node('exp', `${id_}e`, [['A', `${id_}n.result`]]),
          node('addition', `${id_}p`, [
            ['A', `${id_}one.value`],
            ['B', `${id_}e.result`],
          ]),
          node('log', `${id_}l`, [['A', `${id_}p.result`]]),
          node('multiplication', `${id_}r`, [
            ['A', rc],
            ['B', `${id_}l.result`],
          ]),
          node('subtraction', `${id_}t`, [
            ['A', `${id_}m.result`],
            ['B', `${id_}r.result`],
          ]),
          node('select', id_, [
            ['A', 'zero.value'],
            ['B', rc],
            ['C', `${id_}t.result`],
            ['D', `${id_}m.result`],
          ]),
        );
        return;
      case 'chamfer_min':
        nodes.push(
          `   <i:constant identifier="${id_}h" value="${num(Math.SQRT1_2)}"><i:out><i:scalar identifier="value"/></i:out></i:constant>`,
          node('min', `${id_}m`, [
            ['A', ra],
            ['B', rb],
          ]),
          node('addition', `${id_}s`, [
            ['A', ra],
            ['B', rb],
          ]),
          node('subtraction', `${id_}u`, [
            ['A', `${id_}s.result`],
            ['B', rc],
          ]),
          node('multiplication', `${id_}v`, [
            ['A', `${id_}u.result`],
            ['B', `${id_}h.value`],
          ]),
          node('min', id_, [
            ['A', `${id_}m.result`],
            ['B', `${id_}v.result`],
          ]),
        );
        return;
      case 'mesh_sdf': {
        const direct = ra === 'dpos.x' && rb === 'dpos.y' && rc === 'dpos.z';
        if (!direct)
          nodes.push(
            `   <i:composevector identifier="${id_}p"><i:in>${scalarRef('x', ra)}${scalarRef('y', rb)}${scalarRef('z', rc)}</i:in><i:out><i:vector identifier="result"/></i:out></i:composevector>`,
          );
        nodes.push(
          `   <i:mesh identifier="${id_}"><i:in><i:vectorref identifier="pos" ref="${direct ? 'inputs.pos' : `${id_}p.result`}"/><i:resourceref>${meshIds[instruction.args[3] as number]}</i:resourceref></i:in><i:out><i:scalar identifier="distance"/></i:out></i:mesh>`,
        );
        refs[index] = `${id_}.distance`;
        return;
      }
      default: {
        const simple = SIMPLE[instruction.op];
        if (simple !== undefined) {
          nodes.push(
            node(simple, id_, [
              ['A', ra],
              ['B', rb],
            ]),
          );
          return;
        }
        nodes.push(node(UNARY[instruction.op] ?? instruction.op, id_, [['A', ra]]));
      }
    }
  });
  return [
    `  <i:implicitfunction id="${id}" displayname="${escapeXml(name)}">`,
    '   <i:in><i:vector identifier="pos"/></i:in>',
    ...nodes,
    `   <i:out>${scalarRef('shape', reg(program.output))}</i:out>`,
    '  </i:implicitfunction>',
  ].join('\n');
}

/** Resources and object of a levelset body: helper meshes, domain box, the function, then the object `objectId`; `firstId` is the first free resource id. */
export function levelSetXml(
  objectId: number,
  firstId: number,
  name: string,
  materialIndex: number,
  levelset: ThreeMfLevelSet,
): { resources: string[]; object: string; nextId: number } {
  let next = firstId;
  const meshIds = levelset.meshes.map(() => next++);
  const domainId = next++;
  const functionId = next++;
  const resources = [
    ...levelset.meshes.map((tris, index) => otherObjectXml(meshIds[index] as number, `${name} operand ${index}`, tris)),
    otherObjectXml(domainId, `${name} domain`, levelset.domain),
    implicitFunctionXml(functionId, name, levelset.program, meshIds),
  ];
  const s = levelset.toFunction;
  const object = [
    `  <object id="${objectId}" type="model" name="${escapeXml(name)}" pid="1" pindex="${materialIndex}">`,
    `   <v:levelset functionid="${functionId}" channel="shape" transform="${s} 0 0 0 ${s} 0 0 0 ${s} 0 0 0" minfeaturesize="${num(levelset.minFeatureSize)}" meshid="${domainId}" meshbboxonly="true"/>`,
    '  </object>',
  ].join('\n');
  return { resources, object, nextId: next };
}
