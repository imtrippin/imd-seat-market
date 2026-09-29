import test from 'node:test';
import assert from 'node:assert/strict';
import { hashTypedData, encodeFunctionData, parseAbi } from 'viem';
import { parseExpiry, validatePairing, buildMessage, completionBody, typedData, validateArtifact, validateIntent, expiryProblems, encodeOffer, decodeOffer, validateHostingOffer, checkPairingOfferAgainstVault, HOSTING_PREFIX, PAIRING_PREFIX } from '../lib/pairing.js';

const expect = { relay: 'https://api.imd.fun', chain: 1, collection: '0x' + 'ab'.repeat(20), token: '2048', vault: '0x' + 'cd'.repeat(20) };
const good = { code: 'ABCD2345', deviceKey: 'aa'.repeat(32), nonce: 'bb'.repeat(32), relayOrigin: expect.relay, chainId: 1, nftContract: expect.collection };
const now = 1_800_000_000_000;
const registrar = '0x' + 'ee'.repeat(20);
const intentData = encodeFunctionData({ abi: parseAbi(['function register(uint8 standard, address tokenContract, uint256 tokenId, string agentURI)']), functionName: 'register', args: [0, expect.collection, 2048n, 'https://api.imd.fun/agents/by-token/2048.json'] });
const message = buildMessage(good, expect, 1_800_000_600);
const artifact = { code: good.code, vault: expect.vault, collection: expect.collection, chain: 1, message, digest: '0x' + 'dd'.repeat(32), codeExpiresAt: 1_800_000_500_500, intent: { to: registrar, data: intentData, chainId: 1 }, agentId: null };

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
});

test('the completion body names exactly the six transport fields, unprefixed and as strings where IMD wants them', () => {
  const body = completionBody({ ...artifact, message: { ...message, extra: 1 } }, '0x01');
  assert.deepEqual(Object.keys(body.message), ['deviceKey', 'wallet', 'tokenId', 'nonce', 'expiresAt', 'relayOrigin']);
  assert.equal(body.message.deviceKey, 'aa'.repeat(32));
  assert.equal(body.message.wallet, expect.vault.toLowerCase());
  assert.equal(typeof body.message.tokenId, 'string');
  assert.equal(body.message.expiresAt, 1_800_000_600);
  assert.equal(typeof hashTypedData(typedData(artifact)), 'string');
});

test('the artifact and the registration intent are validated field by field', () => {
  assert.deepEqual(validateArtifact(artifact), []);
  assert.equal(validateArtifact({ ...artifact, digest: 'nope' }).length, 1);
  assert.equal(validateArtifact({ ...artifact, message: { ...message, wallet: '0x' + '11'.repeat(20) } }).length, 1);
  assert.deepEqual(validateIntent(artifact.intent, { registrar, chain: 1, collection: expect.collection, token: '2048' }), []);
  assert.equal(validateIntent(artifact.intent, { registrar: '0x' + '99'.repeat(20), chain: 1, collection: expect.collection, token: '2048' }).length, 1, 'wrong registrar');
  assert.equal(validateIntent(artifact.intent, { registrar, chain: 1, collection: expect.collection, token: '2049' }).length, 1, 'another seat');
  assert.equal(validateIntent({ to: registrar, chainId: 1, data: '0x1aa3a008' + '00'.repeat(96) }, { registrar, chain: 1, collection: expect.collection, token: '2048' }).length >= 2, true, 'old registry selector and zero words');
});

test('both clocks are checked: whole-second signature expiry and millisecond code expiry', () => {
  assert.deepEqual(expiryProblems(artifact, 1_800_000_500_499), []);
  assert.equal(expiryProblems(artifact, 1_800_000_500_500).length, 1, 'the code deadline is exact to the millisecond');
  assert.equal(expiryProblems({ ...artifact, codeExpiresAt: null }, 1_800_000_600_000).length, 1, 'the signature expiry has passed');
});

test('offer strings round-trip without Node APIs and refuse the wrong prefix', () => {
  const offer = { v: 1, provider: '0x' + '11'.repeat(20), operator: '0x' + '22'.repeat(20), deviceKey: '0x' + 'aa'.repeat(32), providerBps: 3000, chainId: 1, relayOrigin: expect.relay, collection: expect.collection };
  const text = encodeOffer(HOSTING_PREFIX, offer);
  assert.ok(text.startsWith('seathost1:'));
  assert.deepEqual(decodeOffer(HOSTING_PREFIX, ' ' + text + '\n'), offer);
  assert.throws(() => decodeOffer(PAIRING_PREFIX, text), /not a seatpair1/);
  assert.deepEqual(validateHostingOffer(offer, { chain: 1, relay: expect.relay, collection: expect.collection }), []);
  assert.equal(validateHostingOffer({ ...offer, operator: offer.provider, providerBps: 10_001 }, { chain: 1, relay: expect.relay }).length, 2);
  const pairingText = encodeOffer(PAIRING_PREFIX, artifact);
  assert.deepEqual(decodeOffer(PAIRING_PREFIX, pairingText), artifact);
});

test('the owner\'s checks on a pasted pairing string bind it to the vault, chain, relay, device, seat and intent', () => {
  const vault = { address: expect.vault, tokenId: '2048', deviceKey: '0x' + 'aa'.repeat(32) };
  const config = { chainId: 1, relayOrigin: expect.relay, collection: expect.collection, registrar };
  assert.deepEqual(checkPairingOfferAgainstVault(artifact, vault, config, now), []);
  assert.equal(checkPairingOfferAgainstVault(artifact, { ...vault, address: '0x' + '12'.repeat(20) }, config, now).filter((p) => p.includes('another vault')).length, 1);
  assert.equal(checkPairingOfferAgainstVault(artifact, { ...vault, deviceKey: '0x' + 'ac'.repeat(32) }, config, now).filter((p) => p.includes('device key')).length, 1);
  assert.equal(checkPairingOfferAgainstVault(artifact, vault, { ...config, registrar: '0x' + '99'.repeat(20) }, now).filter((p) => p.includes('registrar')).length, 1);
  assert.equal(checkPairingOfferAgainstVault(artifact, vault, config, 1_800_000_600_000).length, 2, 'both clocks have passed');
});
