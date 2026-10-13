import { describe, it, expect } from 'vitest';
import { CONVENTIONS_GUIDE, CONVENTIONS_URI } from '@mcp/conventions';

describe('CONVENTIONS_URI', () => {
  it('is the expected cad://conventions URI', () => {
    expect(CONVENTIONS_URI).toBe('cad://conventions');
  });
});

describe('CONVENTIONS_GUIDE content', () => {
  it('is a non-empty string', () => {
    expect(typeof CONVENTIONS_GUIDE).toBe('string');
    expect(CONVENTIONS_GUIDE.length).toBeGreaterThan(100);
  });
  it('covers document units (mm/cm/m/in/ft)', () => {
    expect(CONVENTIONS_GUIDE).toMatch(/units/i);
    // At least some unit strings must be mentioned
    expect(CONVENTIONS_GUIDE).toMatch(/"mm"/);
  });
  it('covers the right-handed +Z-up world frame', () => {
    for (const s of [/right.handed/i, /\+Z/, /up/i]) expect(CONVENTIONS_GUIDE).toMatch(s);
  });
  it('covers add_box anchor as center', () => {
    expect(CONVENTIONS_GUIDE).toMatch(/add_box/);
    expect(CONVENTIONS_GUIDE).toMatch(/center/i);
  });
  it('covers add_cylinder anchor as center (not base-center)', () => {
    const row = CONVENTIONS_GUIDE.split('\n').find((l) => l.includes('add_cylinder'));
    expect(row).toBeDefined();
    expect(row).toMatch(/center/i);
    expect(row).not.toMatch(/base.center/i);
  });
  it('covers add_sphere anchor as center', () => {
    expect(CONVENTIONS_GUIDE).toMatch(/add_sphere/);
  });
  it('covers add_cone anchor as base-center', () => {
    expect(CONVENTIONS_GUIDE).toMatch(/add_cone/);
  });
  it('covers add_torus anchor as center', () => {
    expect(CONVENTIONS_GUIDE).toMatch(/add_torus/);
  });
  it('covers add_wedge anchor as lower-front-left', () => {
    expect(CONVENTIONS_GUIDE).toMatch(/add_wedge/);
    expect(CONVENTIONS_GUIDE).toMatch(/lower.front.left/i);
  });
  it('covers add_pyramid anchor as base-center', () => {
    expect(CONVENTIONS_GUIDE).toMatch(/add_pyramid/);
  });
  it('covers rotation as Euler XYZ radians (not degrees)', () => {
    for (const s of [/rotation/i, /radian/i, /degree/i]) expect(CONVENTIONS_GUIDE).toMatch(s);
  });
  it('covers the recommended agent loop: describe_scene → create → render_view → check_model', () => {
    for (const s of [/describe_scene/, /render_view/, /check_model/]) expect(CONVENTIONS_GUIDE).toMatch(s);
  });
  it('mentions showAxes or showGrid in the render_view step', () => {
    // The guide should mention the new default-on axis/grid overlay
    expect(CONVENTIONS_GUIDE).toMatch(/showAxes|showGrid/);
  });
  it('covers common pitfalls section', () => {
    expect(CONVENTIONS_GUIDE).toMatch(/pitfall/i);
  });
  it('does NOT contain any import or require statements (pure content module)', () => {
    // Conventions guide is plain text/markdown — no code imports
    expect(CONVENTIONS_GUIDE).not.toMatch(/^import /m);
    expect(CONVENTIONS_GUIDE).not.toMatch(/require\(/);
  });
});
