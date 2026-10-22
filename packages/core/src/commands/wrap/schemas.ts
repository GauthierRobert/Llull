/** Parameter fragments shared by the face commands of 03 WRP: the face pick and the sketch-to-face placement. */

import { looseVec2, looseVec3, z } from '../schema';

export const faceRefField = z
  .object({
    faceIndex: z.number().int().min(0).optional().describe('Unique face index of the solid (inspect_faces / inspect_topology list them).'),
    faceNear: looseVec3(
      'A point on or near the intended face [x, y, z] in world document units; the face nearest to it is taken.',
    ).optional(),
    faceName: z
      .string()
      .optional()
      .describe('Persistent face name recorded by an earlier run of this command; wins over faceIndex and faceNear.'),
  })
  .describe(
    'The face to work on: give faceNear (a point on the face), or faceIndex, or faceName. The command records the face name so a later edit of the model finds the same face (REF_LOST when it is gone).',
  );

export const placementField = z
  .object({
    method: z
      .enum(['develop', 'geodesic', 'parametric', 'project'])
      .optional()
      .describe(
        'How the sketch is carried onto the face. develop (default) keeps every length and angle and works on plane, cylinder and cone faces (Gaussian curvature 0). geodesic, parametric and project are not built yet (WRP_METHOD_UNAVAILABLE); a sphere or freeform face is WRP_FACE_NOT_DEVELOPABLE with develop.',
      ),
    anchor: z
      .object({
        chart: looseVec2('Sketch point [x, y] (sketch plane document units) that lands on `on`. Default [0, 0].').optional(),
        on: looseVec3(
          'Point [x, y, z] on the face where the sketch point lands. Default: the point of the face nearest to faceNear (else the face centroid).',
        ).optional(),
      })
      .optional()
      .describe('Where the sketch sits on the face: sketch point `chart` lands on face point `on`.'),
    angleDeg: z
      .number()
      .optional()
      .describe(
        'Turn of the sketch in degrees, counter-clockwise seen from outside the face, from the face reference direction (cylinder / cone: around the axis, +azimuth; plane: the face x direction). Default 0.',
      ),
    mirror: z.boolean().optional().describe('Flip the sketch y axis (a wrap seen from inside). Default false.'),
  })
  .describe(
    'Sketch-to-face placement. Chart axes: x follows the circumference (cylinder / cone: +azimuth about the axis from the face x direction; plane: the face x direction), y follows the axis (cone: away from the apex along the generator; plane: normal x x direction). Lengths and angles are kept (develop).',
  );
