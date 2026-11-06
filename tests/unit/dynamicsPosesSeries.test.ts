/** simulate_motion detail 'poses' (PHY-22 TR-MOV-04): the poses and the joint series of ONE run, (render_animation reads it). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { planDocument } from './renderAnimationFixtures';

beforeAll(async () => setPhysicsEngine(await createMujocoPhysics()));
afterAll(() => setPhysicsEngine(null));

interface Run {
  poses?: { times: number[]; bodies: Record<string, { position: number[][]; orientation: number[][] }> };
  series?: { times: number[]; jointPosition: Record<string, number[]> };
}

describe("simulate_motion detail 'poses'", () => {
  const { document } = planDocument('mov_slider_crank_video.plan.json');
  const simulate = (detail?: string): Run =>
    execute(document, 'simulate_motion', { duration: 0.01, timestep: 2e-5, sampleRate: 50000, ...(detail === undefined ? {} : { detail }) })
      .data as Run;

  it('returns the poses of every body and the position series of the joints, on the same sample times', () => {
    const both = simulate('poses');
    expect(Object.keys(both.poses?.bodies ?? {}).sort()).toEqual(['crank', 'piston', 'rod']);
    expect(both.series?.times).toEqual(both.poses?.times);
    expect(Object.keys(both.series?.jointPosition ?? {})).toEqual(expect.arrayContaining(['j_crank', 'j_slide']));
    expect(both.poses?.times.length).toBe(501);
    expect(both.poses?.bodies['piston']?.position).toHaveLength(501);
  });

  it('keeps summary without poses or series and series without poses', () => {
    const both = simulate('poses');
    const summary = simulate();
    expect(summary.poses).toBeUndefined();
    expect(summary.series).toBeUndefined();
    const series = simulate('series');
    expect(series.series).toEqual(both.series);
    expect(series.poses).toBeUndefined();
  });

  it('rejects an unknown detail (poses+series is not a value) through the schema', () => {
    const result = execute(document, 'simulate_motion', { duration: 0.01, detail: 'poses+series' });
    expect(result.summary).toMatch(/invalid params/);
    expect(result.data).toBeUndefined();
  });
});
