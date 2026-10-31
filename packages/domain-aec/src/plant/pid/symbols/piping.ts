/** Inline piping symbols (valves, fittings, flanges), instrument bubbles, actuators and connectors of the built-in library (plant 04 PID FR-PID-01). */

import type { Vec2 } from '@core/model/vectors';
import type { PidActuating, PidInstrument } from '../model';
import { circle, ellipse, line, poly, rect, text, type PidSymbol, type Shape } from './shapes';

/** Half length of an inline symbol along the flow axis (the ports sit at +/- this, `add_pid_inline`). */
export const INLINE_HALF = 5;
const H = INLINE_HALF;
const W = 3.2;

const bowTie: Shape[] = [
  poly([
    [-H, -W],
    [0, 0],
    [-H, W],
  ]),
  poly([
    [H, -W],
    [0, 0],
    [H, W],
  ]),
];

function drawingOf(cls: string): Shape[] {
  switch (cls) {
    case 'BallValve':
      return [...bowTie, circle([0, 0], 1.6)];
    case 'GlobeValve':
      return [...bowTie, circle([0, 0], 1.6, true)];
    case 'GateValve':
      return [
        ...bowTie,
        line([
          [0, 0],
          [0, W + 1.5],
        ]),
      ];
    case 'ButterflyValve':
      return [
        line([
          [-H, 0],
          [H, 0],
        ]),
        line([
          [0, -W],
          [0, W],
        ]),
        line(
          [
            [-H, -W],
            [H, W],
          ],
          'thin',
        ),
      ];
    case 'PlugValve':
      return [
        ...bowTie,
        poly(
          [
            [-1.2, 0],
            [0, -1.6],
            [1.2, 0],
            [0, 1.6],
          ],
          true,
        ),
      ];
    case 'NeedleValve':
      return [
        ...bowTie,
        line([
          [0, 0],
          [0, W + 2],
        ]),
        line([
          [-1, W + 2],
          [1, W + 2],
        ]),
      ];
    case 'DiaphragmValve':
      return [
        ...bowTie,
        line([
          [-2, W],
          [0, W + 1.5],
          [2, W],
        ]),
      ];
    case 'SwingCheckValve':
      return [
        poly([
          [-H, -W],
          [H, 0],
          [-H, W],
        ]),
        line([
          [H, -W],
          [H, W],
        ]),
      ];
    case 'SpringLoadedGlobeSafetyValve':
      return [
        poly([
          [-H, -W],
          [0, 0],
          [-H, W],
        ]),
        poly([
          [0, 0],
          [H, W],
          [H, -W],
        ]),
        line([
          [0, 0],
          [-1.2, W + 1],
          [1.2, W + 2],
          [-1.2, W + 3],
          [0, W + 4],
        ]),
      ];
    case 'OperatedValve':
      return [
        ...bowTie,
        line([
          [0, 0],
          [0, W + 1],
        ]),
        rect(1.8, 1.4).t === 'line'
          ? poly([
              [-1.8, W + 1],
              [1.8, W + 1],
              [1.8, W + 3.8],
              [-1.8, W + 3.8],
            ])
          : rect(1, 1),
      ];
    case 'PipeTee':
      return [
        line([
          [-H, 0],
          [H, 0],
        ]),
        line([
          [0, 0],
          [0, -H],
        ]),
        circle([0, 0], 0.8, true),
      ];
    case 'PipeReducer':
      return [
        poly([
          [-H, -W],
          [H, -1.5],
          [H, 1.5],
          [-H, W],
        ]),
      ];
    case 'PipeFitting':
      return [circle([0, 0], 1.4)];
    case 'BlindFlange':
      return [
        line([
          [-H, 0],
          [0, 0],
        ]),
        line([
          [0, -W],
          [0, W],
        ]),
        line([
          [1, -W],
          [1, W],
        ]),
      ];
    case 'Flange':
      return [
        line([
          [-H, 0],
          [H, 0],
        ]),
        line([
          [-1, -W],
          [-1, W],
        ]),
        line([
          [1, -W],
          [1, W],
        ]),
      ];
    case 'RestrictionOrifice':
      return [
        line([
          [-H, 0],
          [H, 0],
        ]),
        line([
          [-1.2, -W],
          [-1.2, W],
        ]),
        line([
          [1.2, -W],
          [1.2, W],
        ]),
      ];
    default:
      return [rect(H, W)];
  }
}

/** The symbol of a piping component class (a tee has a third port on the branch side). */
export function pipingSymbol(cls: string): PidSymbol {
  const ports: Vec2[] =
    cls === 'PipeTee'
      ? [
          [-H, 0],
          [H, 0],
          [0, -H],
        ]
      : [
          [-H, 0],
          [H, 0],
        ];
  return {
    class: cls,
    name: cls.replace(/([a-z])([A-Z])/g, '$1 $2'),
    family: 'piping',
    halfWidth: H,
    halfHeight: W,
    ports,
    shapes: drawingOf(cls),
  };
}

/** Bubble radius, mm. */
export const BUBBLE_R = 6;

/** Instrument bubble by location (ISA 5.1 secondary sources, documentation only: discrete circle; central = one line; local panel = two lines; auxiliary = dashed line). */
export function instrumentSymbol(location: PidInstrument['location'], display: PidInstrument['display']): PidSymbol {
  const r = BUBBLE_R;
  const bar: Shape[] =
    location === 'field'
      ? []
      : location === 'central'
        ? [
            line([
              [-r, 0],
              [r, 0],
            ]),
          ]
        : location === 'local_panel'
          ? [
              line([
                [-r, 0.6],
                [r, 0.6],
              ]),
              line([
                [-r, -0.6],
                [r, -0.6],
              ]),
            ]
          : [
              line(
                [
                  [-r, 0],
                  [r, 0],
                ],
                'hidden',
              ),
            ];
  const frame: Shape[] =
    display === 'shared'
      ? [rect(r + 1.5, r + 1.5)]
      : display === 'plc'
        ? [
            poly([
              [0, r + 3],
              [r + 3, 0],
              [0, -r - 3],
              [-r - 3, 0],
            ]),
          ]
        : display === 'software'
          ? [poly(ellipse(0, 0, r + 2.5, r + 2.5, 6))]
          : [];
  return {
    class: `Instrument:${location}:${display}`,
    name: `Instrument bubble (${location.replace('_', ' ')}, ${display})`,
    family: 'instrument',
    halfWidth: r + 3,
    halfHeight: r + 3,
    ports: [
      [0, -r - 3],
      [0, r + 3],
    ],
    shapes: [circle([0, 0], r), ...bar, ...frame],
  };
}

/** Actuator head drawn above a valve (stem at the origin, head centred 8 mm up). */
export function actuatorSymbol(kind: PidActuating['actuator']): PidSymbol {
  const stem = line([
    [0, 0],
    [0, 5],
  ]);
  const head: Shape[] =
    kind === 'diaphragm'
      ? [
          poly([
            [-3.5, 5],
            [-3.03, 6.75],
            [-1.75, 8.03],
            [0, 8.5],
            [1.75, 8.03],
            [3.03, 6.75],
            [3.5, 5],
          ]),
        ]
      : kind === 'motor'
        ? [circle([0, 8], 3), text([0, 8], 2.5, 'M')]
        : kind === 'solenoid'
          ? [
              poly([
                [-3, 5],
                [3, 5],
                [3, 11],
                [-3, 11],
              ]),
              text([0, 8], 2.5, 'S'),
            ]
          : kind === 'hydraulic'
            ? [
                poly([
                  [-3, 5],
                  [3, 5],
                  [3, 11],
                  [-3, 11],
                ]),
                text([0, 8], 2.5, 'H'),
              ]
            : kind === 'piston'
              ? [
                  poly([
                    [-3, 5],
                    [3, 5],
                    [3, 11],
                    [-3, 11],
                  ]),
                  line([
                    [-3, 8],
                    [3, 8],
                  ]),
                ]
              : [
                  poly([
                    [-3, 5],
                    [3, 5],
                    [3, 11],
                    [-3, 11],
                  ]),
                ];
  return {
    class: `Actuator:${kind}`,
    name: `Actuator (${kind})`,
    family: 'actuator',
    halfWidth: 3.5,
    halfHeight: 11,
    ports: [[0, 0]],
    shapes: [stem, ...head],
  };
}

/** Off-page connector: a pentagon arrow pointing right (`out`) or left (`in`). */
export function connectorSymbol(direction: 'in' | 'out'): PidSymbol {
  const sign = direction === 'out' ? 1 : -1;
  const pts: Vec2[] = [
    [-7 * sign, -4],
    [3 * sign, -4],
    [7 * sign, 0],
    [3 * sign, 4],
    [-7 * sign, 4],
  ];
  return {
    class: direction === 'out' ? 'FlowOutPipeOffPageConnector' : 'FlowInPipeOffPageConnector',
    name: `Off-page connector (${direction})`,
    family: 'connector',
    halfWidth: 7,
    halfHeight: 4,
    ports: [[-7 * sign, 0]],
    shapes: [poly(pts)],
  };
}

/** Flow arrow (solid triangle pointing along +x). */
export const flowArrowSymbol: PidSymbol = {
  class: 'PipeFlowArrow',
  name: 'Flow arrow',
  family: 'annotation',
  halfWidth: 2,
  halfHeight: 1.2,
  ports: [],
  shapes: [
    poly(
      [
        [-2, -1.2],
        [2, 0],
        [-2, 1.2],
      ],
      true,
    ),
  ],
};
