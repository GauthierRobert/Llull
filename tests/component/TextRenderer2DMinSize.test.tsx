/** TextRenderer2D keeps annotation text readable when zoomed out (min on-screen size hook). */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { TextEntity } from '@core/model/types';

const minSize = vi.hoisted(() => vi.fn());
vi.mock('@ui/viewport/2d/useMinScreenSize', () => ({ useMinScreenSize: minSize }));
vi.mock('@react-three/drei', () => ({ Text: () => null }));

import { TextRenderer2D } from '@ui/viewport/2d/entities/TextRenderer2D';

describe('TextRenderer2D', () => {
  it('applies the minimum-screen-size rule with the entity cap height', () => {
    const entity: TextEntity = {
      id: 't1',
      kind: 'text',
      content: 'Label',
      height: 2.5,
      position: [1, 2, 0],
      rotation: [0, 0, 0],
      layerId: 'layer-default',
      color: '#ffffff',
    };
    render(<TextRenderer2D entity={entity} selected={false} />);
    expect(minSize).toHaveBeenCalledWith(expect.anything(), 2.5);
  });
});
