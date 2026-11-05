import { describe, expect, it } from 'vitest';
import { requireTool } from '../../requireTool';

describe.skipIf(requireTool('python:ocp', false))('suite that needs a tool nobody provides', () => {
  it('never runs', () => {
    expect(true).toBe(true);
  });
});

it('runs', () => {
  expect(true).toBe(true);
});
