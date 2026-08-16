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

async function bootstrap() {
  const [reactModule, reactDomModule, testEnvironmentModule] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('./lib/testSandboxEnvironment'),
    import('./index.css'),
  ]);

  const { StrictMode, createElement } = reactModule;
  const { createRoot } = reactDomModule;
  const { installTestSandboxEnvironment } = testEnvironmentModule;

  installTestSandboxEnvironment();

  const shouldSimulateBootstrapError = typeof window !== 'undefined'
    && localStorage.getItem('erp_provider_mode') === 'test'
    && new URLSearchParams(window.location.search).get('simulateBootstrapError') === '1';

  if (shouldSimulateBootstrapError) {
    throw new Error('TEST_ONLY_BOOTSTRAP_FAILURE');
  }

  const [{ default: App }, { dataProvider }] = await Promise.all([
    import('./App.tsx'),
    import('./providers/dataProvider'),
  ]);

  if (typeof window !== 'undefined') {
    (window as any).dataProvider = dataProvider;
  }

  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('ROOT_ELEMENT_MISSING');

  createRoot(rootElement).render(
    createElement(StrictMode, null, createElement(App)),
  );
}

function renderBootstrapFailure(error: unknown) {
  console.error('[Bootstrap Fatal]', error);

  if (typeof document === 'undefined') return;

  const isTestMode = (() => {
    try {
      return localStorage.getItem('erp_provider_mode') === 'test';
    } catch {
      return false;
    }
  })();

  document.title = isTestMode ? '[TEST ERROR] 小河馬 ERP' : '[ERROR] 小河馬 ERP';
  document.body.dataset.bootstrapError = 'BOOTSTRAP_FAILED';

  const rootElement = document.getElementById('root') || document.body.appendChild(document.createElement('div'));
  rootElement.id ||= 'root';
  rootElement.replaceChildren();

  const panel = document.createElement('main');
  panel.setAttribute('role', 'alert');
  panel.style.cssText = 'box-sizing:border-box;max-width:560px;margin:12vh auto;padding:32px;border:1px solid #fecaca;border-radius:16px;background:#fff;box-shadow:0 18px 50px rgba(15,23,42,.12);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1e293b;';

  const title = document.createElement('h1');
  title.textContent = '系統啟動失敗';
  title.style.cssText = 'margin:0 0 12px;font-size:26px;color:#b91c1c;';

  const message = document.createElement('p');
  message.textContent = '系統無法完成初始化。請重新載入；若問題持續，請停止操作並聯絡管理員。';
  message.style.cssText = 'margin:0 0 8px;line-height:1.7;';

  const code = document.createElement('p');
  code.textContent = '錯誤代碼：BOOTSTRAP_FAILED';
  code.style.cssText = 'margin:0 0 20px;color:#64748b;font-size:13px;';

  const reloadButton = document.createElement('button');
  reloadButton.type = 'button';
  reloadButton.textContent = '重新載入';
  reloadButton.style.cssText = 'padding:10px 18px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-weight:700;cursor:pointer;';
  reloadButton.addEventListener('click', () => window.location.reload(), { once: true });

  panel.append(title, message, code, reloadButton);
  rootElement.appendChild(panel);
}

void bootstrap().catch(renderBootstrapFailure);
