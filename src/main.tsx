import React from 'react';
import ReactDOM from 'react-dom/client';
// Bundled fonts (CSP-safe, offline). User picks one in Settings → Appearance.
import '@fontsource-variable/inter';
import '@fontsource-variable/geist';
import '@fontsource-variable/manrope';
import '@fontsource-variable/plus-jakarta-sans';
import App from './App';
import './styles.css';

// Production only: disable the right-click context menu (which is the only path to any
// inspect-like action) EVERYWHERE except editable fields, so copy/paste/select still work
// in text inputs. In dev it's left enabled so devtools/inspect stay available for debugging.
if (import.meta.env.PROD) {
  document.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target?.closest('input, textarea, [contenteditable="true"]')) {
      e.preventDefault();
    }
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
