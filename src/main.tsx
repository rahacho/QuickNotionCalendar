import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/global.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');
const root = createRoot(container);

function render(node: ReactNode) {
  root.render(<StrictMode>{node}</StrictMode>);
}

function renderLoadError() {
  render(
    <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--text-secondary)' }}>
      <button type="button" onClick={() => window.location.reload()} style={{ padding: 8 }}>
        Couldn’t load Tasks · Tap to reload
      </button>
    </div>,
  );
}

// Dev-only component gallery (?gallery): never part of a production build (the branch is dead code there).
if (import.meta.env.DEV && window.location.search.includes('gallery')) {
  import('./dev/Gallery').then(({ Gallery }) => render(<Gallery />), renderLoadError);
} else {
  import('./App').then(({ App }) => render(<App />), renderLoadError);
}
