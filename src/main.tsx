import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@ui/App';
import '@ui/styles.css';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@ui/geometry/manifoldKernel';

// ---------------------------------------------------------------------------
// Kernel selection: ?kernel=occt swaps in OCC (dev/power-user toggle).
// Default is Manifold. OCC is opt-in only — never the default.
//
// Usage: http://localhost:5173/?kernel=occt
//
// OCC carries a 63 MB WASM binary (~800–1000 ms cold init). It is injected
// asynchronously so the first render is never blocked. Commands no-op
// gracefully until the kernel resolves (architecture L9 / SOLID S5).
// ---------------------------------------------------------------------------

const useOcct =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('kernel') === 'occt';

if (useOcct) {
  // Lazy-import OCC so its 63 MB WASM is never fetched in the default path.
  import('@ui/geometry/occtKernel')
    .then(({ createOcctKernel }) => createOcctKernel())
    .then(setGeometryKernel)
    .catch((e: unknown) => {
      console.warn('OCC kernel init failed — falling back to Manifold', e);
      createManifoldKernel()
        .then(setGeometryKernel)
        .catch((e2: unknown) => console.error('Manifold kernel init failed', e2));
    });
} else {
  // Default: Manifold — fast, no large WASM asset.
  createManifoldKernel()
    .then(setGeometryKernel)
    .catch((e: unknown) => console.error('Manifold kernel init failed', e));
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found.');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
