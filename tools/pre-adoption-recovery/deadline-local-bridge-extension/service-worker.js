const PROTOCOL = 'ERP2_DEADLINE_LOCAL_BRIDGE_V1';
const RECEIVER = 'http://127.0.0.1:45173';
const ERP2_SETTINGS_PREFIX = 'https://hippo-erp-realtime-preview.pages.dev/settings';
const sessions = new Map();

const fail = code => { throw new Error(`DEADLINE_LOCAL_BRIDGE_FAILED_CLOSED:${code}`); };

const assertSender = sender => {
  if (!Number.isInteger(sender?.tab?.id) || sender.frameId !== 0
    || typeof sender.url !== 'string' || !sender.url.startsWith(ERP2_SETTINGS_PREFIX)) {
    fail('SENDER_REJECTED');
  }
  return sender.tab.id;
};

const receiverRequest = async (path, { token = null, body = null } = {}) => {
  const headers = {
    'X-ERP2-Deadline-Bridge-Protocol': PROTOCOL,
    'X-ERP2-Deadline-Extension-Id': chrome.runtime.id,
  };
  if (token) headers['X-ERP2-Deadline-Bridge-Token'] = token;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${RECEIVER}${path}`, {
    method: body ? 'POST' : 'GET', headers,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store', credentials: 'omit', redirect: 'error',
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.result === 'FAIL') fail(result?.code ?? 'LOCAL_RECEIVER_REJECTED');
  return result;
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = async () => {
    const tabId = assertSender(sender);
    if (message?.protocol !== PROTOCOL) fail('PROTOCOL_MISMATCH');
    if (message.kind === 'GET_SESSION') {
      const session = await receiverRequest('/v1/session');
      if (session.protocol !== PROTOCOL || typeof session.bridgeToken !== 'string') fail('SESSION_INVALID');
      sessions.set(tabId, session);
      const { bridgeToken: _privateToken, ...publicSession } = session;
      return publicSession;
    }
    if (message.kind !== 'FORWARD') fail('MESSAGE_KIND_REJECTED');
    const session = sessions.get(tabId);
    if (!session || message.payload?.sessionId !== session.sessionId) fail('SESSION_MISMATCH');
    const route = {
      ERP2_DEADLINE_BRIDGE_META: '/v1/meta',
      ERP2_DEADLINE_BRIDGE_CHUNK: '/v1/chunk',
      ERP2_DEADLINE_BRIDGE_COMPLETE: '/v1/complete',
    }[message.payload?.type];
    if (!route) fail('PAYLOAD_TYPE_REJECTED');
    return receiverRequest(route, { token: session.bridgeToken, body: message.payload });
  };
  run().then(result => sendResponse({ result: 'PASS', value: result }))
    .catch(error => sendResponse({ result: 'FAIL', code: String(error?.message ?? error) }));
  return true;
});

chrome.tabs?.onRemoved?.addListener(tabId => sessions.delete(tabId));
