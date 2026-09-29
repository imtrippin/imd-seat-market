import test from 'node:test';
import assert from 'node:assert/strict';
import { pairingStartDisabled } from '../public/setup.js';

test('the room gates the start button only in room mode; the manual path keeps the action list\'s own state', () => {
  // manual mode (no room sign-in): the renderer must not override the button
  assert.equal(pairingStartDisabled({ roomMode: false, enabled: false, role: 'host', bothReady: false, active: false, error: null }), null);
  // room mode: disabled until both are ready and nothing is in flight
  const base = { roomMode: true, enabled: true, role: 'host', bothReady: true, active: false, error: null };
  assert.equal(pairingStartDisabled(base), false);
  assert.equal(pairingStartDisabled({ ...base, bothReady: false }), true);
  assert.equal(pairingStartDisabled({ ...base, active: true }), true);
  assert.equal(pairingStartDisabled({ ...base, role: 'owner' }), true);
  assert.equal(pairingStartDisabled({ ...base, error: 'Setup service unavailable' }), true, 'a signed-in room whose service is down does not fall back to manual mode');
  assert.equal(pairingStartDisabled({ ...base, enabled: false }), true);
});
