import test from 'node:test';
import assert from 'node:assert/strict';
import { hashTypedData } from 'viem';
import { parseExpiry, validatePairing, buildMessage, completionBody, typedData, walletTypedData, validateArtifact, expiryProblems, encodeOffer, decodeOffer, validateHostingOffer, HOSTING_PREFIX, PAIRING_PREFIX } from '../lib/pairing.js';

const expect = { relay: 'https://api.imd.fun', chain: 1, collection: '0x' + 'ab'.repeat(20), token: '2048', vault: '0x' + 'cd'.repeat(20) };
const good = { code: 'ABCD2345', deviceKey: 'aa'.repeat(32), nonce: 'bb'.repeat(32), relayOrigin: expect.relay, chainId: 1, nftContract: expect.collection };
const now = 1_800_000_000_000;

test('parseExpiry reads seconds, milliseconds and ISO', () => {
  assert.equal(parseExpiry(1_800_000_300), 1_800_000_300_000);
  assert.equal(parseExpiry(1_800_000_300_000), 1_800_000_300_000);
  assert.equal(parseExpiry('1800000300'), 1_800_000_300_000);
  assert.equal(parseExpiry('2027-02-01T00:00:00Z'), Date.parse('2027-02-01T00:00:00Z'));
  assert.ok(Number.isNaN(parseExpiry('soon')));
  assert.equal(parseExpiry(undefined), null);
});

test('validatePairing accepts IMD\'s shape and refuses the wrong relay, chain, collection, consumed and expired codes', () => {
  assert.deepEqual(validatePairing(good, expect, now), []);
  assert.equal(validatePairing({ ...good, relayOrigin: 'https://evil.example', chainId: 8453, nonce: 'zz', consumed: true }, expect, now).length, 4);
  assert.equal(validatePairing({ ...good, expiresAt: '1799999000000' }, expect, now).length, 1);
  assert.equal(validatePairing({ ...good, expiresAt: '2027-02-01T00:00:00Z' }, expect, now).length, 0);
  assert.equal(validatePairing({ ...good, code: 'x' }, expect, now).length, 1);
});

test('the completion body names exactly the six transport fields, unprefixed and as strings where IMD wants them', () => {
  const message = buildMessage(good, expect, 1_800_000_600);
  const artifact = { code: good.code, vault: expect.vault, collection: expect.collection, chain: 1, message };
  const body = completionBody({ ...artifact, message: { ...message, extra: 1 } }, '0x01');
  assert.deepEqual(Object.keys(body.message), ['deviceKey', 'wallet', 'tokenId', 'nonce', 'expiresAt', 'relayOrigin']);
  assert.equal(body.message.deviceKey, 'aa'.repeat(32));
  assert.equal(body.message.wallet, expect.vault.toLowerCase());
  assert.equal(typeof body.message.tokenId, 'string');
  assert.equal(body.message.expiresAt, 1_800_000_600);
  assert.equal(body.code, 'ABCD2345');
  assert.deepEqual(validateArtifact(artifact), []);
  assert.equal(validateArtifact({ ...artifact, message: { ...message, wallet: '0x' + '11'.repeat(20) } }).length, 1);
});

test('the wallet typed data hashes to the same digest as the viem typed data', () => {
  const message = buildMessage(good, expect, 1_800_000_600);
  const artifact = { code: good.code, vault: expect.vault, collection: expect.collection, chain: 1, message };
  const a = hashTypedData(typedData(artifact));
  const w = walletTypedData(artifact);
  assert.ok(w.types.EIP712Domain && w.types.WorkerAuthorization);
  assert.equal(typeof w.message.tokenId, 'string');
  const b = hashTypedData({ domain: w.domain, types: { WorkerAuthorization: w.types.WorkerAuthorization }, primaryType: w.primaryType, message: { ...w.message, tokenId: BigInt(w.message.tokenId), expiresAt: BigInt(w.message.expiresAt) } });
  assert.equal(a, b);
});

test('both clocks are checked: whole-second signature expiry and millisecond code expiry', () => {
  const message = buildMessage(good, expect, 1_800_000_600);
  const a = { code: good.code, vault: expect.vault, collection: expect.collection, chain: 1, message, codeExpiresAt: 1_800_000_500_500 };
  assert.deepEqual(expiryProblems(a, 1_800_000_500_499), []);
  assert.equal(expiryProblems(a, 1_800_000_500_500).length, 1, 'the code deadline is exact to the millisecond');
  assert.equal(expiryProblems({ ...a, codeExpiresAt: null }, 1_800_000_600_000).length, 1, 'the signature expiry has passed');
});

test('offer strings round-trip and refuse the wrong prefix', () => {
  const offer = { v: 1, provider: '0x' + '11'.repeat(20), operator: '0x' + '22'.repeat(20), deviceKey: '0x' + 'aa'.repeat(32), providerBps: 3000, chainId: 1, relayOrigin: expect.relay };
  const text = encodeOffer(HOSTING_PREFIX, offer);
  assert.ok(text.startsWith('seathost1:'));
  assert.deepEqual(decodeOffer(HOSTING_PREFIX, ' ' + text + '\n'), offer);
  assert.throws(() => decodeOffer(PAIRING_PREFIX, text), /not a seatpair1/);
  assert.deepEqual(validateHostingOffer(offer, { chain: 1, relay: expect.relay }), []);
  assert.equal(validateHostingOffer({ ...offer, operator: offer.provider, providerBps: 10_001 }, { chain: 1, relay: expect.relay }).length, 2);
  assert.equal(validateHostingOffer({ ...offer, chainId: 8453 }, { chain: 1, relay: expect.relay }).length, 1);
});
