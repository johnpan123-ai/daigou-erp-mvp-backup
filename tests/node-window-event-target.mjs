import assert from 'node:assert/strict';
import { nodeWindowEventTarget } from './helpers/node-window-event-target.mjs';

const windowTarget = nodeWindowEventTarget({ marker: 'isolated' });
const received = [];
const listener = event => received.push(event.type);

windowTarget.addEventListener('storage', listener);
assert.equal(windowTarget.dispatchEvent(new Event('storage')), true);
assert.deepEqual(received, ['storage']);
assert.equal(windowTarget.marker, 'isolated');

windowTarget.removeEventListener('storage', listener);
assert.equal(windowTarget.dispatchEvent(new Event('storage')), true);
assert.deepEqual(received, ['storage'], 'removed listener must not receive later events');

console.log('PASS Node window harness uses native EventTarget registration, dispatch and removal semantics');
