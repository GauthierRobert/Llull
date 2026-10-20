// Primitive solids: box, cylinder, cone, sphere, torus, wedge, pyramid.
import { addCase, mesh } from './caseKit.mjs';
import { PI, box, cone, cylinder, pyramid, sphere, torus, wedge } from './formulas.mjs';

const AREA_MESH = 'area is summed over display triangles of a curved face; the volume is closed-form';

export function primitiveCases(out) {
  const F = 'primitive';
  const one = (name, description, formula, command, params, p, extra = {}) =>
    addCase(out, { family: F, name, description, formula, actions: [{ command, params }], p, ...extra });

  one('box-unit', 'unit cube at the origin', 'V = abc; A = 2(ab+bc+ca)', 'add_box', { size: [1, 1, 1] }, box([1, 1, 1]), { faces: 6 });
  one(
    'box-offset',
    'box 2x3x4 centred at (1,1,1)',
    'V = abc',
    'add_box',
    { size: [2, 3, 4], position: [1, 1, 1] },
    box([2, 3, 4], [1, 1, 1]),
    { faces: 6 },
  );
  one('box-plate', 'thin plate 100x50x2', 'V = abc', 'add_box', { size: [100, 50, 2] }, box([100, 50, 2]), { faces: 6 });
  one(
    'box-anchor-min',
    'box anchored by its min corner at (5,5,5)',
    'centre = min + size/2',
    'add_box',
    { size: [2, 3, 4], position: [5, 5, 5], anchor: 'min' },
    box([2, 3, 4], [6, 6.5, 7]),
  );
  one(
    'box-anchor-base',
    'box anchored by its base centre',
    'centre z = base z + c/2',
    'add_box',
    { size: [2, 3, 4], position: [0, 0, 1], anchor: 'base-center' },
    box([2, 3, 4], [0, 0, 3]),
  );
  one(
    'box-rot-z90',
    'box 2x3x4 turned 90 degrees about Z: X and Y extents swap',
    'bbox of a rotated box',
    'add_box',
    { size: [2, 3, 4], rotation: [0, 0, PI / 2] },
    box([3, 2, 4]),
  );
  one(
    'box-rot-x90',
    'box 2x3x4 turned 90 degrees about X: Y and Z extents swap',
    'bbox of a rotated box',
    'add_box',
    { size: [2, 3, 4], rotation: [PI / 2, 0, 0] },
    box([2, 4, 3]),
  );

  const cyl = (name, description, params, p, extra = {}) =>
    one(name, description, 'V = pi r^2 h; A = 2 pi r (r+h)', 'add_cylinder', params, p, { faces: 3, ...extra });
  cyl('cylinder-basic', 'cylinder r=2 h=5', { radius: 2, height: 5 }, cylinder(2, 5));
  cyl('cylinder-offset', 'cylinder r=1.5 h=4 at (3,-2,1)', { radius: 1.5, height: 4, position: [3, -2, 1] }, cylinder(1.5, 4, [3, -2, 1]));
  cyl(
    'cylinder-base-anchor',
    'cylinder anchored at its base centre',
    { radius: 2, height: 5, position: [0, 0, 3], anchor: 'base-center' },
    cylinder(2, 5, [0, 0, 5.5]),
  );
  cyl('cylinder-disc', 'thin disc r=10 h=0.5', { radius: 10, height: 0.5 }, cylinder(10, 0.5));
  cyl(
    'cylinder-axis-x',
    'cylinder r=2 h=6 with its axis along +X',
    { radius: 2, height: 6, axis: [1, 0, 0] },
    { ...cylinder(2, 6), min: [-3, -2, -2], max: [3, 2, 2] },
  );

  const con = (name, description, params, p, extra = {}) =>
    one(name, description, 'V = pi r^2 h / 3; A = pi r (r + sqrt(r^2+h^2)); centroid at h/4 from the base', 'add_cone', params, p, {
      mesh: mesh(null, 0.02, AREA_MESH),
      ...extra,
    });
  con('cone-basic', 'cone r=2 h=3 on the XY plane', { radius: 2, height: 3 }, cone(2, 3));
  con(
    'cone-centered',
    'cone r=3 h=4 anchored by the centre of its AABB',
    { radius: 3, height: 4, anchor: 'center' },
    cone(3, 4, [0, 0, -2]),
  );
  con('cone-tall', 'tall cone r=1 h=10 at (2,2,2)', { radius: 1, height: 10, position: [2, 2, 2] }, cone(1, 10, [2, 2, 2]));
  con(
    'cone-axis-y',
    'cone r=2 h=3 with its apex towards +Y',
    { radius: 2, height: 3, axis: [0, 1, 0] },
    { ...cone(2, 3), c: [0, 0.75, 0], min: [-2, 0, -2], max: [2, 3, 2] },
  );

  const sph = (name, description, params, p) =>
    one(name, description, 'V = 4/3 pi r^3; A = 4 pi r^2', 'add_sphere', params, p, { faces: 1 });
  sph('sphere-r2', 'sphere r=2', { radius: 2 }, sphere(2));
  sph('sphere-small-offset', 'sphere r=0.5 at (1,2,3)', { radius: 0.5, position: [1, 2, 3] }, sphere(0.5, [1, 2, 3]));
  sph('sphere-large', 'sphere r=10', { radius: 10 }, sphere(10));

  const tor = (name, description, params, p, extra = {}) =>
    one(name, description, 'V = 2 pi^2 R r^2; A = 4 pi^2 R r', 'add_torus', params, p, { mesh: mesh(null, 0.03, AREA_MESH), ...extra });
  tor('torus-basic', 'torus R=5 r=1', { ringRadius: 5, tubeRadius: 1 }, torus(5, 1));
  tor('torus-offset', 'torus R=3 r=0.5 at (1,1,1)', { ringRadius: 3, tubeRadius: 0.5, position: [1, 1, 1] }, torus(3, 0.5, [1, 1, 1]));
  tor('torus-fat', 'fat torus R=10 r=2', { ringRadius: 10, tubeRadius: 2 }, torus(10, 2));
  tor(
    'torus-axis-x',
    'torus R=4 r=1 with its axis along X',
    { ringRadius: 4, tubeRadius: 1, axis: [1, 0, 0] },
    { ...torus(4, 1), min: [-1, -5, -5], max: [1, 5, 5] },
  );

  const wdg = (name, description, params, p) =>
    one(name, description, 'V = whd/2; centroid (w/2, h/3, d/3) from the min corner', 'add_wedge', params, p);
  wdg('wedge-basic', 'wedge 2x3x4 at the origin (min anchor)', { size: [2, 3, 4] }, wedge([2, 3, 4]));
  wdg(
    'wedge-offset',
    'wedge 10x4x6 with its min corner at (1,1,1)',
    { size: [10, 4, 6], position: [1, 1, 1] },
    wedge([10, 4, 6], [1, 1, 1]),
  );
  wdg('wedge-thin', 'thin wedge 20x1x8', { size: [20, 1, 8] }, wedge([20, 1, 8]));

  const pyr = (name, description, params, p) =>
    one(name, description, 'V = w d h / 3; centroid at h/4 above the base', 'add_pyramid', params, p);
  pyr('pyramid-basic', 'pyramid base 2x3 height 4', { baseWidth: 2, baseDepth: 3, height: 4 }, pyramid(2, 3, 4));
  pyr('pyramid-square', 'square pyramid 5x5x5', { baseWidth: 5, baseDepth: 5, height: 5 }, pyramid(5, 5, 5));
  pyr(
    'pyramid-offset',
    'pyramid 4x2x6 with its base centre at (3,3,3)',
    { baseWidth: 4, baseDepth: 2, height: 6, position: [3, 3, 3] },
    pyramid(4, 2, 6, [3, 3, 3]),
  );
}
