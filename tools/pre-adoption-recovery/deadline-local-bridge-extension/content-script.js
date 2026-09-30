const PROTOCOL = 'ERP2_DEADLINE_LOCAL_BRIDGE_V1';
const ERP2_ORIGIN = 'https://hippo-erp-realtime-preview.pages.dev';
let session = null;
let transferId = null;
let starting = false;

const postStart = () => window.postMessage({
  protocol: PROTOCOL,
  type: 'ERP2_DEADLINE_BRIDGE_START',
  sessionId: session.sessionId,
  expected: session.expected,
  databaseName: session.databaseName,
  stores: session.stores,
}, ERP2_ORIGIN);

const failClosed = code => {
  window.postMessage({
    protocol: PROTOCOL,
    type: 'ERP2_DEADLINE_BRIDGE_EXTENSION_ERROR',
    sessionId: session?.sessionId ?? null,
    code: `DEADLINE_LOCAL_BRIDGE_FAILED_CLOSED:${code}`,
  }, ERP2_ORIGIN);
};

const getSessionAndStart = async () => {
  if (session) { postStart(); return; }
  if (starting) return;
  starting = true;
  try {
    const response = await chrome.runtime.sendMessage({ protocol: PROTOCOL, kind: 'GET_SESSION' });
    if (response?.result !== 'PASS' || response.value?.protocol !== PROTOCOL) throw new Error('SESSION_UNAVAILABLE');
    session = response.value;
    postStart();
  } catch (error) {
    starting = false;
    failClosed(String(error?.message ?? error));
  }
};

window.addEventListener('message', async event => {
  if (event.source !== window || event.origin !== ERP2_ORIGIN || event.data?.protocol !== PROTOCOL) return;
  if (event.data.type === 'ERP2_DEADLINE_BRIDGE_READY') {
    await getSessionAndStart();
    return;
  }
  if (!session || event.data.sessionId !== session.sessionId) return;
  if (event.data.type === 'ERP2_DEADLINE_BRIDGE_MAIN_ERROR') {
    await chrome.runtime.sendMessage({
      protocol: PROTOCOL, kind: 'FORWARD_ERROR', payload: event.data,
    }).catch(() => null);
    return;
  }
  if (!['ERP2_DEADLINE_BRIDGE_META', 'ERP2_DEADLINE_BRIDGE_CHUNK', 'ERP2_DEADLINE_BRIDGE_COMPLETE'].includes(event.data.type)) return;
  if (transferId == null && event.data.type === 'ERP2_DEADLINE_BRIDGE_META') transferId = event.data.transferId;
  if (!transferId || event.data.transferId !== transferId) { failClosed('TRANSFER_MISMATCH'); return; }
  const response = await chrome.runtime.sendMessage({
    protocol: PROTOCOL, kind: 'FORWARD', payload: event.data,
  }).catch(error => ({ result: 'FAIL', code: String(error?.message ?? error) }));
  if (response?.result !== 'PASS') { failClosed(response?.code ?? 'LOCAL_FORWARD_FAILED'); return; }
  window.postMessage({
    protocol: PROTOCOL,
    type: 'ERP2_DEADLINE_BRIDGE_ACK',
    sessionId: session.sessionId,
    transferId,
    ackKey: event.data.ackKey,
  }, ERP2_ORIGIN);
}, false);

if (location.origin === ERP2_ORIGIN && location.pathname === '/settings') void getSessionAndStart();
