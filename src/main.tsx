// Polyfill crypto.randomUUID for insecure contexts (HTTP)
(function polyfillCrypto() {
  try {
    const fallbackUUID = function randomUUID() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    };

    const targetGlobals = [];
    if (typeof globalThis !== 'undefined') targetGlobals.push(globalThis);
    if (typeof window !== 'undefined') targetGlobals.push(window);
    if (typeof self !== 'undefined') targetGlobals.push(self);

    for (const g of targetGlobals) {
      let currentCrypto = (g as any).crypto;
      if (!currentCrypto) {
        try {
          Object.defineProperty(g, 'crypto', {
            value: {},
            writable: true,
            configurable: true,
            enumerable: true
          });
          currentCrypto = (g as any).crypto;
        } catch (e) {
          // ignore
        }
      }

      if (currentCrypto && !currentCrypto.randomUUID) {
        try {
          Object.defineProperty(currentCrypto, 'randomUUID', {
            value: fallbackUUID,
            writable: true,
            configurable: true,
            enumerable: false
          });
        } catch (err) {
          // If crypto is read-only or non-extensible
          const originalCrypto = currentCrypto;
          const newCrypto = Object.create(originalCrypto || {});

          Object.defineProperty(newCrypto, 'randomUUID', {
            value: fallbackUUID,
            writable: true,
            configurable: true,
            enumerable: false
          });

          if (originalCrypto && typeof originalCrypto.getRandomValues === 'function') {
            Object.defineProperty(newCrypto, 'getRandomValues', {
              value: originalCrypto.getRandomValues.bind(originalCrypto),
              writable: true,
              configurable: true,
              enumerable: false
            });
          }

          try {
            Object.defineProperty(g, 'crypto', {
              value: newCrypto,
              configurable: true,
              writable: true,
              enumerable: true
            });
          } catch (e2) {
            // Last resort: assign directly
            try {
              (g as any).crypto = newCrypto;
            } catch (e3) {
              console.error('Failed to override crypto object:', e3);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('Failed to polyfill crypto.randomUUID:', e);
  }
})();

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { dataProvider } from './providers/dataProvider'

if (typeof window !== 'undefined') {
  (window as any).dataProvider = dataProvider;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
