import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PanelSection } from '@ui/panels/PanelParts';

const header = (): HTMLElement => screen.getByRole('button', { name: /Terrain/ });

describe('PanelSection', () => {
  it('follows defaultOpen until the user toggles it, then keeps the user choice', () => {
    const { rerender } = render(
      <PanelSection collapsible defaultOpen={false} title="Terrain">
        <p>body</p>
      </PanelSection>,
    );
    expect(header()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('body')).toBeNull();
    // the AI adds a surface: the step gets content and opens by itself
    rerender(
      <PanelSection collapsible defaultOpen title="Terrain">
        <p>body</p>
      </PanelSection>,
    );
    expect(screen.getByText('body')).toBeInTheDocument();
    fireEvent.click(header());
    rerender(
      <PanelSection collapsible defaultOpen title="Terrain">
        <p>body</p>
      </PanelSection>,
    );
    expect(header()).toHaveAttribute('aria-expanded', 'false');
  });

  it('ticks a done workflow step instead of numbering it', () => {
    render(
      <PanelSection collapsible step={2} done title="Terrain">
        <p>body</p>
      </PanelSection>,
    );
    expect(screen.getByLabelText('Step 2 (done):')).not.toHaveTextContent('2');
  });
});
