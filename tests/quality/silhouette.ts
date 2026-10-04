import type { Locator, Page } from '@playwright/test';

/**
 * @layer tests/quality
 *
 * Where the model is on screen: pixels that differ between a canvas shot WITH the model and one
 * WITHOUT it from the same camera (pixel work runs in the page via canvas 2D decode, so Node
 * needs no image library).
 */

export interface Silhouette {
  readonly pixels: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  /** Bounding rectangle of the mask, in screenshot pixels; null when the mask is empty. */
  readonly rect: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

/** Hides every DOM element except canvases and their ancestors (toolbars, hints, cards). */
const HIDE_OVERLAYS = 'body *:not(canvas):not(:has(canvas)) { visibility: hidden !important; }';

/** Screenshot of the canvas alone, after the demand frameloop has painted. */
export async function shootCanvas(page: Page, canvas: Locator): Promise<Buffer> {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  await page.waitForTimeout(250);
  const style = await page.addStyleTag({ content: HIDE_OVERLAYS });
  const shot = await canvas.screenshot();
  await style.evaluate((element) => (element as HTMLElement).remove());
  return shot;
}

export async function silhouette(page: Page, shot: Buffer, baseline: Buffer): Promise<Silhouette> {
  return page.evaluate(
    async ([a, b]) => {
      async function pixelsOf(base64: string): Promise<ImageData> {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        if (context === null) throw new Error('no 2D context');
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height);
      }
      const [first, second] = await Promise.all([pixelsOf(a), pixelsOf(b)]);
      const inMask = (offset: number): boolean => {
        const r = first.data[offset] ?? 0;
        const g = first.data[offset + 1] ?? 0;
        const blue = first.data[offset + 2] ?? 0;
        return (
          Math.abs(r - (second.data[offset] ?? 0)) > 24 ||
          Math.abs(g - (second.data[offset + 1] ?? 0)) > 24 ||
          Math.abs(blue - (second.data[offset + 2] ?? 0)) > 24
        );
      };
      let pixels = 0;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let y = 0; y < first.height; y += 1) {
        for (let x = 0; x < first.width; x += 1) {
          if (!inMask((y * first.width + x) * 4)) continue;
          pixels += 1;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      return {
        pixels,
        canvasWidth: first.width,
        canvasHeight: first.height,
        rect: pixels === 0 ? null : { minX, minY, maxX, maxY },
      };
    },
    [shot.toString('base64'), baseline.toString('base64')] as const,
  );
}

/** Width / height of the silhouette rectangle (pixel-inclusive). */
export function aspectOf(rect: NonNullable<Silhouette['rect']>): number {
  return (rect.maxX - rect.minX + 1) / (rect.maxY - rect.minY + 1);
}

/** Visible, not cut off by the canvas border, and covering at least `minFill` of the canvas. */
export function isFramed(shape: Silhouette, minFill: number, margin = 1): boolean {
  if (shape.rect === null) return false;
  const { minX, minY, maxX, maxY } = shape.rect;
  const fill = ((maxX - minX + 1) * (maxY - minY + 1)) / (shape.canvasWidth * shape.canvasHeight);
  return (
    fill >= minFill &&
    minX >= margin &&
    minY >= margin &&
    maxX <= shape.canvasWidth - 1 - margin &&
    maxY <= shape.canvasHeight - 1 - margin
  );
}
