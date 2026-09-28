import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, createAgreement, createHost, transition, termsKey, currentVersion, pendingVersion, available, unfundedHostShare, coverageAt, graceEnd, reviewEligible, demoScenario, restoreState, HOUR, PAYER, reserveBalance, serviceMinimum, hostEntitlement, billingPeriods, collectibleDue, unsecuredExposure, pauseRecommended, arrivalKey, PERIOD, TRANSFER_DELAY, deviceConnected } from '../dist/model.js';
const input = {
  hostId: 'northstar',
  nft: '2048',
  ownerBps: 7000,
  wallet: 'demo-wallet-2048',
  dedicatedWallet: true
};
const make = () => createAgreement(initialState(), input);
function approve(state, id, role) {
  const v = pendingVersion(state.agreements.find(a => a.id === id));
  return transition(state, id, 'approve', role, {
    version: v.number,
    termsKey: termsKey(v)
  });
}
function accepted() {
  let {
    state,
    id
  } = make();
  for (const role of ['owner', 'host']) state = approve(state, id, role);
  return {
    state,
    id
  };
}
function ready() {
  let {
    state,
    id
  } = accepted();
  state = transition(state, id, 'deposit', 'owner', {
    amount: 1000
  });
  return {
    id,
    state: transition(state, id, 'pair', 'demo')
  };
}
function arrive(state, id, extra = {}) {
  return transition(state, id, 'arrive', 'demo', {
    arrivalId: 'arrival-' + (state.seq + 1),
    amount: 10000,
    payer: PAYER,
    wallet: state.agreements.find(a => a.id === id).wallet,
    ...extra
  });
}
function pay(state, id, amount = unfundedHostShare(state.agreements.find(a => a.id === id), state.now)) {
  return transition(state, id, 'pay', 'owner', {
    amount
  });
}
function attest(state, id, arrival = state.agreements.find(a => a.id === id).arrivals.find(r => r.version !== null && !state.agreements.find(a => a.id === id).attestations.some(t => t.arrivalId === r.id))) {
  return transition(state, id, 'attest', 'owner', {
    arrivalId: arrival.id,
    arrivalKey: arrivalKey(arrival)
  });
}
function disconnected(state, id) {
  state = transition(state, id, 'advance', 'demo', {
    ms: TRANSFER_DELAY
  });
  return transition(state, id, 'disconnect-transfer', 'demo');
}
const review = {
  rating: 3,
  comment: 'A sufficient example service review.'
};
test('approval is bilateral and binds every exact term', () => {
  let {
    state,
    id
  } = make();
  const initial = JSON.stringify(state);
  assert.throws(() => transition(state, id, 'approve', 'owner', {
    version: 1,
    termsKey: 'wrong'
  }));
  assert.throws(() => transition(state, id, 'approve', 'demo', {
    version: 1,
    termsKey: termsKey(state.agreements[0].versions[0])
  }));
  assert.equal(JSON.stringify(state), initial);
  state = approve(state, id, 'owner');
  assert.equal(currentVersion(state.agreements[0]), null);
  assert.throws(() => transition(state, id, 'pair', 'demo'));
  state = approve(state, id, 'host');
  assert.equal(currentVersion(state.agreements[0]).number, 1);
  assert.equal(state.agreements[0].routing, 'owner-wallet');
  assert.equal(state.agreements[0].pairing, 'unpaired');
});
test('counterproposal cancels old approvals; stale acceptance fails', () => {
  let {
    state,
    id
  } = make();
  const v = state.agreements[0].versions[0];
  state = approve(state, id, 'owner');
  state = transition(state, id, 'amend', 'host', {
    ownerBps: 6500
  });
  assert.throws(() => transition(state, id, 'approve', 'host', {
    version: 1,
    termsKey: termsKey(v)
  }));
  assert.deepEqual(pendingVersion(state.agreements[0]).approvals, {
    owner: false,
    host: false
  });
  for (const role of ['owner', 'host']) state = approve(state, id, role);
  assert.equal(currentVersion(state.agreements[0]).ownerBps, 6500);
});
test('today owner receives arrivals: owed provider share is not a funded claim', () => {
  let {
    state,
    id
  } = ready();
  state = arrive(state, id);
  const a = state.agreements[0];
  assert.equal(a.arrivals[0].amount, 10000);
  assert.equal(unfundedHostShare(a, state.now), 3000);
  assert.equal(available(a, 'host'), 0);
  assert.equal(available(a, 'owner'), 0);
  assert.throws(() => transition(state, id, 'withdraw', 'host'));
  assert.throws(() => transition(state, id, 'pay', 'host', {
    amount: 3000
  }));
});
test('owner pays only provider debt, supports partial payment, and cannot overpay or claim owner rewards', () => {
  let {
    state,
    id
  } = ready();
  state = arrive(state, id);
  assert.throws(() => pay(state, id, 3001));
  assert.throws(() => transition(state, id, 'pay', 'host', {
    amount: 1
  }));
  state = pay(state, id, 1000);
  assert.equal(unfundedHostShare(state.agreements[0], state.now), 2000);
  state = pay(state, id);
  assert.equal(state.agreements[0].payments.reduce((n, r) => n + r.amount, 0), 3000);
  assert.equal(reserveBalance(state.agreements[0]), 1000);
  assert.equal(available(state.agreements[0], 'owner'), 0);
  assert.throws(() => transition(state, id, 'withdraw', 'owner'));
  assert.throws(() => pay(state, id, 1));
  state = transition(state, id, 'withdraw', 'host');
  assert.equal(available(state.agreements[0], 'host'), 0);
  assert.throws(() => transition(state, id, 'withdraw', 'host'));
});
test('arrivals after amendment use NEW terms regardless of earlier work; prior arrivals retain old terms', () => {
  let {
    state,
    id
  } = ready();
  state = arrive(state, id);
  state = transition(state, id, 'amend', 'host', {
    ownerBps: 8000
  });
  state = approve(state, id, 'owner');
  state = arrive(state, id);
  state = approve(state, id, 'host');
  state = arrive(state, id);
  assert.deepEqual(state.agreements[0].arrivals.map(r => [r.version, r.owner, r.host]), [[1, 7000, 3000], [1, 7000, 3000], [2, 8000, 2000]]);
  state = pay(state, id);
  assert.equal(available(state.agreements[0], 'host'), 8000);
});
test('version boundary belongs to newly accepted terms', () => {
  let {
    state,
    id
  } = ready();
  state = transition(state, id, 'amend', 'host', {
    ownerBps: 8000
  });
  for (const role of ['owner', 'host']) state = approve(state, id, role);
  const a = state.agreements[0],
    at = currentVersion(a).startAt;
  assert.equal(coverageAt(a, at - 1).version, 1);
  assert.equal(coverageAt(a, at).version, 2);
});
test('either party may end; exact 72-hour exit deadline is excluded', () => {
  for (const role of ['owner', 'host']) {
    let {
      state,
      id
    } = ready();
    state = transition(state, id, 'end', role);
    const a = state.agreements[0],
      deadline = graceEnd(a);
    assert.equal(coverageAt(a, a.ended.at).phase, 'grace');
    assert.equal(coverageAt(a, deadline - 1).version, 1);
    assert.equal(coverageAt(a, deadline).version, null);
    assert.equal(coverageAt(a, deadline + 1).version, null);
    assert.throws(() => transition(state, id, 'amend', 'owner', {
      ownerBps: 8000
    }));
  }
});
test('voluntary payment after grace preserves the ARRIVAL split; observation alone cannot pay', () => {
  let {
    state,
    id
  } = ready();
  state = transition(state, id, 'end', 'owner');
  state = arrive(state, id);
  state = transition(state, id, 'advance', 'demo', {
    ms: 72 * HOUR
  });
  state = arrive(state, id);
  assert.equal(state.agreements[0].arrivals[0].phase, 'grace');
  assert.equal(state.agreements[0].arrivals[1].version, null);
  state = pay(state, id);
  state = transition(state, id, 'withdraw', 'host');
  assert.equal(available(state.agreements[0], 'owner'), 0);
  assert.throws(() => pay(state, id, 1));
});
test('before acceptance, wrong payer, and changed wallet are not covered', () => {
  let {
    state,
    id
  } = make();
  state = arrive(state, id);
  assert.equal(state.agreements[0].arrivals[0].version, null);
  for (const role of ['owner', 'host']) state = approve(state, id, role);
  state = arrive(state, id, {
    payer: 'Other source'
  });
  state = arrive(state, id, {
    wallet: 'new-owner-wallet'
  });
  assert.ok(state.agreements[0].arrivals.every(r => r.version === null));
  assert.equal(unfundedHostShare(state.agreements[0], state.now), 0);
});
test('arrival IDs are unique, even across agreements; no backdating or invalid amounts', () => {
  let {
    state,
    id
  } = ready();
  state = arrive(state, id, {
    arrivalId: 'same-event'
  });
  assert.throws(() => arrive(state, id, {
    arrivalId: 'same-event'
  }));
  const second = createAgreement(state, {
    ...input,
    nft: '2049',
    wallet: 'demo-2049'
  });
  state = second.state;
  assert.throws(() => arrive(state, second.id, {
    arrivalId: 'same-event'
  }));
  for (const amount of [0, -1, 0.5, NaN, Infinity, 100000001]) assert.throws(() => arrive(state, id, {
    amount
  }));
  assert.throws(() => arrive(state, id, {
    at: state.now - 1000
  }));
});
test('pending amendment can be discarded without changing arrival coverage', () => {
  let {
    state,
    id
  } = ready();
  state = transition(state, id, 'amend', 'owner', {
    ownerBps: 6000
  });
  assert.throws(() => transition(state, id, 'amend', 'host', {
    ownerBps: 7000
  }));
  state = transition(state, id, 'discard', 'host');
  assert.equal(pendingVersion(state.agreements[0]), null);
  state = arrive(state, id);
  assert.equal(state.agreements[0].arrivals[0].owner, 7000);
});
test('exit cancels pending terms and grace uses last accepted terms', () => {
  let {
    state,
    id
  } = ready();
  state = transition(state, id, 'amend', 'owner', {
    ownerBps: 6000
  });
  state = transition(state, id, 'end', 'host');
  assert.equal(pendingVersion(state.agreements[0]), null);
  state = arrive(state, id);
  assert.equal(state.agreements[0].arrivals[0].owner, 7000);
  assert.throws(() => approve(state, id, 'owner'));
});
test('wallet declaration required; one hosted NFT per wallet and capacity limits enforced', () => {
  assert.throws(() => createAgreement(initialState(), {
    ...input,
    dedicatedWallet: false
  }));
  assert.throws(() => createAgreement(initialState(), {
    ...input,
    wallet: '<script>'
  }));
  let {
    state
  } = make();
  assert.throws(() => createAgreement(state, {
    ...input,
    nft: '2'
  }));
  assert.throws(() => createAgreement(state, {
    ...input,
    nft: '002048',
    wallet: 'different-wallet'
  }));
  state = createAgreement(state, {
    ...input,
    hostId: 'harbor',
    nft: '2',
    wallet: 'wallet-2'
  }).state;
  assert.throws(() => createAgreement(state, {
    ...input,
    hostId: 'harbor',
    nft: '3',
    wallet: 'wallet-3'
  }));
});
test('host can unlink without prior exit; grace persists and wallet cannot be reused during it', () => {
  let {
    state,
    id
  } = ready();
  state = transition(state, id, 'unlink', 'host');
  assert.equal(state.agreements[0].pairing, 'unlinked');
  assert.equal(state.agreements[0].ended.reason, 'host unlink');
  assert.throws(() => createAgreement(state, input));
  state = transition(state, id, 'advance', 'demo', {
    ms: 72 * HOUR
  });
  assert.doesNotThrow(() => createAgreement(state, input));
});
test('owner transfer-revoke releases old device, permits new dedicated wallet, preserves funded claims', () => {
  let {
    state,
    id
  } = ready();
  state = arrive(state, id);
  state = pay(state, id);
  assert.throws(() => transition(state, id, 'transfer', 'host'));
  state = transition(state, id, 'transfer', 'owner');
  assert.equal(state.agreements[0].pairing, 'transfer-pending');
  assert.throws(() => createAgreement(state, {
    ...input,
    hostId: 'relay',
    wallet: 'new-dedicated-wallet'
  }));
  state = disconnected(state, id);
  assert.equal(state.agreements[0].pairing, 'revoked-by-transfer');
  assert.equal(state.agreements[0].unpairedAt !== null, true);
  state = createAgreement(state, {
    ...input,
    hostId: 'relay',
    wallet: 'new-dedicated-wallet'
  }).state;
  state = transition(state, id, 'withdraw', 'host');
  assert.equal(available(state.agreements[0], 'owner'), 0);
  assert.equal(state.agreements[1].owner, 'Demo owner');
});
test('transfer after exit does not extend the grace deadline; changed destination remains excluded', () => {
  let {
    state,
    id
  } = ready();
  state = transition(state, id, 'end', 'owner');
  const end = graceEnd(state.agreements[0]);
  state = transition(state, id, 'advance', 'demo', {
    ms: HOUR
  });
  state = transition(state, id, 'transfer', 'owner');
  assert.equal(graceEnd(state.agreements[0]), end);
  state = arrive(state, id, {
    wallet: 'new-owner-wallet'
  });
  assert.equal(state.agreements[0].arrivals[0].version, null);
});
test('direct recovery request does not revoke; transfer can close it', () => {
  let {
    state,
    id
  } = ready();
  state = transition(state, id, 'end', 'owner');
  state = transition(state, id, 'recovery', 'owner');
  assert.equal(state.agreements[0].pairing, 'paired');
  assert.throws(() => transition(state, id, 'recovery', 'owner'));
  state = transition(state, id, 'transfer', 'owner');
  assert.equal(state.agreements[0].recoveryRequest.status, 'requested-in-demo');
  state = disconnected(state, id);
  assert.equal(state.agreements[0].recoveryRequest.status, 'resolved-in-demo');
});
test('review without rewards becomes eligible at 24 paired hours, requires owner role', () => {
  let {
    state,
    id
  } = ready();
  assert.throws(() => transition(state, id, 'review', 'owner', review));
  state = transition(state, id, 'advance', 'demo', {
    ms: 24 * HOUR
  });
  assert.equal(reviewEligible(state.agreements[0], state.now), true);
  assert.throws(() => transition(state, id, 'review', 'host', review));
  state = transition(state, id, 'review', 'owner', review);
  assert.equal(state.agreements[0].arrivals.length, 0);
});
test('covered arrival during paired service allows review with no payments or claims', () => {
  let {
    state,
    id
  } = ready();
  state = arrive(state, id);
  state = transition(state, id, 'review', 'owner', review);
  assert.equal(available(state.agreements[0], 'owner'), 0);
  assert.equal(state.agreements[0].review.rating, 3);
});
test('unpaired arrivals, unrelated arrivals and post-exit time do not fabricate service eligibility', () => {
  let {
    state,
    id
  } = accepted();
  state = arrive(state, id);
  assert.equal(reviewEligible(state.agreements[0], state.now), false);
  state = transition(state, id, 'deposit', 'owner', {
    amount: 1000
  });
  state = transition(state, id, 'pair', 'demo');
  state = arrive(state, id, {
    payer: 'Other payer'
  });
  state = transition(state, id, 'end', 'owner');
  state = transition(state, id, 'advance', 'demo', {
    ms: 25 * HOUR
  });
  state = arrive(state, id);
  assert.equal(reviewEligible(state.agreements[0], state.now), false);
});
test('review remains editable after exit and bounds are enforced', () => {
  let state = demoScenario(),
    id = state.agreements[0].id;
  state = transition(state, id, 'review', 'owner', review);
  const created = state.agreements[0].review.createdSeq;
  state = transition(state, id, 'unlink', 'host');
  state = transition(state, id, 'review', 'owner', {
    ...review,
    rating: 1
  });
  assert.equal(state.agreements[0].review.createdSeq, created);
  assert.ok(state.agreements[0].review.updatedSeq > created);
  for (const rating of [0, 6, 3.5]) assert.throws(() => transition(state, id, 'review', 'owner', {
    ...review,
    rating
  }));
  assert.throws(() => transition(state, id, 'review', 'owner', {
    ...review,
    comment: 'short'
  }));
});
test('custom offer snapshots and invalid splits are preserved', () => {
  let state = createHost(initialState(), {
    name: 'Example Host',
    region: 'US East',
    runtime: 'Codex',
    ai: 'Host supplied',
    slots: 2,
    ownerBps: 6000
  });
  state = createAgreement(state, {
    ...input,
    hostId: state.hosts.at(-1).id
  }).state;
  state.hosts.at(-1).name = 'Changed listing';
  assert.equal(state.agreements[0].host.name, 'Example Host');
  for (const ownerBps of [0, 10000, 6500.5]) assert.throws(() => createAgreement(initialState(), {
    ...input,
    ownerBps
  }));
});
test('integer conservation across share and amount extremes, including after exit', () => {
  for (const bps of [100, 1234, 3333, 5000, 9900]) {
    let {
      state,
      id
    } = createAgreement(initialState(), {
      ...input,
      ownerBps: bps
    });
    for (const r of ['owner', 'host']) state = approve(state, id, r);
    state = transition(state, id, 'deposit', 'owner', {
      amount: 1000
    });
    state = transition(state, id, 'pair', 'demo');
    let hostTotal = 0;
    for (const amount of [1, 2, 99, 10001, 99999999]) {
      state = arrive(state, id, {
        amount
      });
      hostTotal += state.agreements[0].arrivals.at(-1).host;
      state = pay(state, id);
    }
    state = transition(state, id, 'end', 'owner');
    state = transition(state, id, 'withdraw', 'host');
    assert.equal(state.agreements[0].withdrawals.reduce((n, w) => n + w.amount, 0), hostTotal);
    assert.equal(available(state.agreements[0], 'owner'), 0);
  }
});
test('demo is restorable and begins with owner-held rewards, not funded claims', () => {
  const state = demoScenario();
  assert.deepEqual(restoreState(JSON.stringify(state)), state);
  assert.equal(unfundedHostShare(state.agreements[0], state.now), 3000);
  assert.equal(available(state.agreements[0], 'host'), 0);
});
test('full amendment, grace, funding, transfer, review lifecycle survives restore', () => {
  let state = demoScenario(),
    id = state.agreements[0].id;
  state = transition(state, id, 'amend', 'host', {
    ownerBps: 6500
  });
  state = transition(state, id, 'discard', 'owner');
  state = transition(state, id, 'amend', 'host', {
    ownerBps: 8000
  });
  for (const r of ['owner', 'host']) state = approve(state, id, r);
  state = transition(state, id, 'end', 'owner');
  state = arrive(state, id);
  state = transition(state, id, 'recovery', 'owner');
  state = transition(state, id, 'transfer', 'owner');
  state = pay(state, id);
  state = transition(state, id, 'withdraw', 'host');
  state = transition(state, id, 'review', 'owner', review);
  assert.deepEqual(restoreState(JSON.stringify(state)), state);
});
test('restore rejects old schema, inconsistent counters, corrupt attribution and reviews', () => {
  const mutations = [s => s.schema = 2, s => s.nextId = 1, s => s.now++, s => s.seq--, s => s.agreements.push(structuredClone(s.agreements[0])), s => s.agreements[0].arrivals[0].owner++, s => s.agreements[0].arrivals[0].version = 99, s => s.agreements[0].versions[0].startAt = null, s => s.agreements[0].review = {
    ...review,
    rating: 999
  }, s => s.agreements[0].pairing = 'invented', s => s.agreements[0].withdrawals.push({
    role: 'owner',
    amount: -1,
    seq: 1,
    at: s.now
  })];
  for (const mutate of mutations) {
    const state = demoScenario();
    mutate(state);
    assert.throws(() => restoreState(JSON.stringify(state)));
  }
});
test('security deposit gates pairing and cannot be withdrawn mid-service', () => {
  let {
    state,
    id
  } = accepted();
  assert.throws(() => transition(state, id, 'pair', 'demo'));
  assert.throws(() => transition(state, id, 'deposit', 'host', {
    amount: 1000
  }));
  state = transition(state, id, 'deposit', 'owner', {
    amount: 999
  });
  assert.throws(() => transition(state, id, 'pair', 'demo'));
  state = transition(state, id, 'deposit', 'owner', {
    amount: 1
  });
  state = transition(state, id, 'pair', 'demo');
  assert.equal(reserveBalance(state.agreements[0]), 1000);
  assert.throws(() => transition(state, id, 'refund', 'owner'));
  assert.throws(() => transition(state, id, 'draw-reserve', 'host'));
});
test('one day with zero rewards is payable from collateral; unused remainder refunds after exit window', () => {
  let {
    state,
    id
  } = ready();
  state = transition(state, id, 'advance', 'demo', {
    ms: 24 * HOUR
  });
  state = transition(state, id, 'transfer', 'owner');
  assert.equal(serviceMinimum(state.agreements[0], state.now), 200);
  state = transition(state, id, 'draw-reserve', 'host');
  assert.equal(available(state.agreements[0], 'host'), 200);
  assert.throws(() => transition(state, id, 'refund', 'owner'));
  state = transition(state, id, 'withdraw', 'host');
  state = transition(state, id, 'advance', 'demo', {
    ms: 72 * HOUR
  });
  state = transition(state, id, 'refund', 'owner');
  assert.equal(state.agreements[0].refunds[0].amount, 800);
  assert.equal(reserveBalance(state.agreements[0]), 0);
  assert.deepEqual(restoreState(JSON.stringify(state)), state);
});
test('reserve draw credits the same period; direct payment does not silently replenish collateral', () => {
  let {
    state,
    id
  } = ready();
  state = transition(state, id, 'advance', 'demo', {
    ms: 12 * HOUR
  });
  state = transition(state, id, 'draw-reserve', 'host');
  assert.equal(reserveBalance(state.agreements[0]), 900);
  state = transition(state, id, 'withdraw', 'host');
  state = arrive(state, id);
  assert.equal(hostEntitlement(state.agreements[0], state.now), 3000);
  state = pay(state, id);
  const a = state.agreements[0];
  assert.equal(a.payments[0].amount, 2900);
  assert.equal(reserveBalance(a), 900);
  assert.equal(available(a, 'host'), 2900);
  assert.equal(available(a, 'owner'), 0);
  assert.equal(unfundedHostShare(a, state.now), 0);
  assert.deepEqual(restoreState(JSON.stringify(state)), state);
});
test('refund leaves unpaid earned minimum reserved for host', () => {
  let {
    state,
    id
  } = ready();
  state = transition(state, id, 'advance', 'demo', {
    ms: 24 * HOUR
  });
  state = transition(state, id, 'end', 'owner');
  state = transition(state, id, 'advance', 'demo', {
    ms: 72 * HOUR
  });
  state = transition(state, id, 'refund', 'owner');
  assert.equal(reserveBalance(state.agreements[0]), 200);
  assert.throws(() => transition(state, id, 'refund', 'owner'));
  state = transition(state, id, 'draw-reserve', 'host');
  state = transition(state, id, 'withdraw', 'host');
  assert.equal(state.agreements[0].refunds[0].amount + state.agreements[0].withdrawals[0].amount, 1000);
});
test('collateral caps protection and does not pretend to guarantee a one-day loss ceiling', () => {
  let {
    state,
    id
  } = ready();
  state = transition(state, id, 'advance', 'demo', {
    ms: 6 * 24 * HOUR
  });
  state = transition(state, id, 'end', 'owner');
  state = transition(state, id, 'draw-reserve', 'host');
  assert.equal(available(state.agreements[0], 'host'), 1000);
  assert.equal(unfundedHostShare(state.agreements[0], state.now), 200);
  assert.equal(reserveBalance(state.agreements[0]), 0);
  assert.throws(() => transition(state, id, 'draw-reserve', 'host'));
});
test('deposits, provider payments, claims, refunds and remaining reserve conserve actual funds', () => {
  let {
    state,
    id
  } = ready();
  for (let day = 0; day < 4; day++) {
    state = transition(state, id, 'advance', 'demo', {
      ms: 24 * HOUR
    });
    if (collectibleDue(state.agreements[0], state.now) && reserveBalance(state.agreements[0])) state = transition(state, id, 'draw-reserve', 'host');
    state = arrive(state, id, {
      amount: [101, 500, 10000, 3][day]
    });
    if (unfundedHostShare(state.agreements[0], state.now)) state = pay(state, id);
    if (available(state.agreements[0], 'host')) state = transition(state, id, 'withdraw', 'host');
  }
  state = transition(state, id, 'end', 'owner');
  state = transition(state, id, 'advance', 'demo', {
    ms: 72 * HOUR
  });
  if (reserveBalance(state.agreements[0]) > collectibleDue(state.agreements[0], state.now)) state = transition(state, id, 'refund', 'owner');
  const a = state.agreements[0];
  const paidIn = a.deposits.reduce((n, r) => n + r.amount, 0) + a.payments.reduce((n, r) => n + r.amount, 0);
  const paidOut = a.withdrawals.reduce((n, r) => n + r.amount, 0) + a.refunds.reduce((n, r) => n + r.amount, 0);
  assert.equal(paidIn, paidOut + reserveBalance(a) + available(a, 'host'));
  assert.deepEqual(restoreState(JSON.stringify(state)), state);
});
test('provider profile captures hardware, skills, LLM choice and collateral in approved snapshot', () => {
  let state = createHost(initialState(), {
    name: 'Demo Specialist',
    region: 'EU West',
    runtime: 'Claude',
    ai: 'Owner arranged',
    slots: 3,
    ownerBps: 8000,
    securityDeposit: 500,
    dailyMinimum: 100,
    machine: {
      cpu: 8,
      ramGb: 32,
      diskGb: 200
    },
    skills: ['Research', 'Code review'],
    llmOptions: ['Claude Code · option A', 'Claude Code · option B'],
    description: 'A specialist research operator.',
    service: 'One seat gets 2 vCPU and 8 GB RAM; daily support.'
  });
  const h = state.hosts.at(-1);
  const created = createAgreement(state, {
    ...input,
    hostId: h.id,
    llm: h.llmOptions[1]
  });
  state = created.state;
  for (const role of ['owner', 'host']) state = approve(state, created.id, role);
  const t = currentVersion(state.agreements[0]).terms;
  assert.equal(t.llm, 'Claude Code · option B');
  assert.equal(t.machine.ramGb, 32);
  assert.equal(t.securityDeposit, 500);
  assert.equal(t.dailyMinimum, 100);
  state.hosts.at(-1).machine.ramGb = 64;
  assert.equal(t.machine.ramGb, 32);
  assert.throws(() => createAgreement(initialState(), {
    ...input,
    llm: 'Unlisted model'
  }));
  assert.deepEqual(restoreState(JSON.stringify(state)), state);
});
test('invalid machine, deposit and profile values are rejected', () => {
  const base = {
    name: 'Demo host',
    region: 'US East',
    runtime: 'Codex',
    ai: 'Host supplied',
    slots: 2,
    ownerBps: 7000
  };
  for (const invalid of [{
    securityDeposit: -1
  }, {
    securityDeposit: 10,
    dailyMinimum: 20
  }, {
    machine: {
      cpu: 0,
      ramGb: 8,
      diskGb: 80
    }
  }, {
    skills: []
  }, {
    llmOptions: ['x']
  }, {
    service: 'short'
  }]) assert.throws(() => createHost(initialState(), {
    ...base,
    ...invalid
  }));
});
test('closing an unaccepted proposal creates neither a grace window nor service liability', () => {
  let {
    state,
    id
  } = make();
  state = transition(state, id, 'end', 'owner');
  assert.equal(graceEnd(state.agreements[0]), null);
  state = arrive(state, id);
  assert.equal(state.agreements[0].arrivals[0].reason, 'Service not activated at arrival');
  assert.equal(hostEntitlement(state.agreements[0], state.now), 0);
  assert.match(state.agreements[0].history[1].text, /No arrival window/);
  assert.deepEqual(restoreState(JSON.stringify(state)), state);
});
test('exposure includes unpaid share after deposit draw and warns at one minimum', () => {
  let state = demoScenario(),
    id = state.agreements[0].id;
  state = attest(state, id);
  state = transition(state, id, 'draw-reserve', 'host');
  const a = state.agreements[0];
  assert.equal(reserveBalance(a), 0);
  assert.equal(unfundedHostShare(a, state.now), 2000);
  assert.equal(unsecuredExposure(a, state.now), 2000);
  assert.equal(pauseRecommended(a, state.now), true);
  assert.deepEqual(restoreState(JSON.stringify(state)), state);
});
test('zero-minimum offer warns on any unsecured share, not on a zero balance', () => {
  let {
    state,
    id
  } = createAgreement(initialState(), {
    ...input,
    hostId: 'harbor'
  });
  for (const role of ['owner', 'host']) state = approve(state, id, role);
  state = transition(state, id, 'pair', 'demo');
  assert.equal(pauseRecommended(state.agreements[0], state.now), false);
  state = arrive(state, id, {
    amount: 1
  });
  assert.equal(unsecuredExposure(state.agreements[0], state.now), 1);
  assert.equal(pauseRecommended(state.agreements[0], state.now), true);
});
test('day-one share cannot prepay fourteen later minimums; worked example totals 58', () => {
  let {
    state,
    id
  } = ready();
  state = transition(state, id, 'advance', 'demo', {
    ms: 12 * HOUR
  });
  state = arrive(state, id);
  state = transition(state, id, 'advance', 'demo', {
    ms: 14 * PERIOD + 12 * HOUR
  });
  state = transition(state, id, 'end', 'owner');
  assert.equal(hostEntitlement(state.agreements[0], state.now), 5800);
  assert.equal(serviceMinimum(state.agreements[0], state.now), 3000);
  assert.equal(billingPeriods(state.agreements[0], state.now)[0].entitlement, 3000);
  assert.deepEqual(restoreState(JSON.stringify(state)), state);
});
test('period boundary, partial final minimum and split amendments have fixed billing anchors', () => {
  let {
    state,
    id
  } = ready();
  const anchor = state.agreements[0].pairedAt;
  state = transition(state, id, 'advance', 'demo', {
    ms: PERIOD - 1
  });
  state = arrive(state, id);
  assert.equal(state.agreements[0].arrivals[0].at, anchor + PERIOD);
  assert.deepEqual(billingPeriods(state.agreements[0], state.now).map(p => p.entitlement), [200, 3000]);
  state = transition(state, id, 'amend', 'owner', {
    ownerBps: 8000
  });
  for (const role of ['owner', 'host']) state = approve(state, id, role);
  state = arrive(state, id);
  assert.equal(billingPeriods(state.agreements[0], state.now)[1].share, 5000);
  state = transition(state, id, 'advance', 'demo', {
    ms: PERIOD + 12 * HOUR
  });
  state = transition(state, id, 'end', 'owner');
  assert.equal(hostEntitlement(state.agreements[0], state.now), 5300);
  assert.equal(state.agreements[0].pairedAt, anchor);
});
test('observations do not authorize a share draw; owner acknowledgment binds exact arrival and does not fund money', () => {
  let {
    state,
    id
  } = ready();
  state = arrive(state, id);
  const r = state.agreements[0].arrivals[0];
  assert.equal(collectibleDue(state.agreements[0], state.now), 0);
  assert.throws(() => transition(state, id, 'draw-reserve', 'host'));
  assert.throws(() => transition(state, id, 'attest', 'host', {
    arrivalId: r.id,
    arrivalKey: arrivalKey(r)
  }));
  assert.throws(() => transition(state, id, 'attest', 'owner', {
    arrivalId: r.id,
    arrivalKey: 'stale'
  }));
  state = attest(state, id);
  assert.equal(collectibleDue(state.agreements[0], state.now), 3000);
  assert.equal(available(state.agreements[0], 'host'), 0);
  assert.throws(() => attest(state, id, r));
  state = transition(state, id, 'draw-reserve', 'host');
  assert.equal(available(state.agreements[0], 'host'), 1000);
});
test('paying an unacknowledged large share cannot prepay another period or block its minimum draw', () => {
  let {
    state,
    id
  } = ready();
  state = arrive(state, id);
  state = pay(state, id);
  assert.equal(state.agreements[0].attestations.length, 0);
  state = transition(state, id, 'advance', 'demo', {
    ms: 2 * PERIOD
  });
  assert.equal(unfundedHostShare(state.agreements[0], state.now), 200);
  assert.equal(collectibleDue(state.agreements[0], state.now), 200);
  state = transition(state, id, 'draw-reserve', 'host');
  assert.equal(state.agreements[0].reserveAllocations[0].allocations[0].period, 1);
  assert.equal(available(state.agreements[0], 'host'), 3200);
  assert.deepEqual(restoreState(JSON.stringify(state)), state);
});
test('unacknowledged claims cannot freeze refund, deadline excludes late acknowledgment, voluntary payment survives', () => {
  let state = demoScenario(),
    id = state.agreements[0].id;
  state = transition(state, id, 'end', 'owner');
  const deadline = graceEnd(state.agreements[0]);
  state = transition(state, id, 'advance', 'demo', {
    ms: deadline - state.now - 1
  });
  assert.throws(() => attest(state, id));
  state = transition(state, id, 'advance', 'demo', {
    ms: 1
  });
  state = transition(state, id, 'refund', 'owner');
  assert.equal(state.agreements[0].refunds[0].amount, 800);
  assert.equal(reserveBalance(state.agreements[0]), 200);
  assert.equal(unfundedHostShare(state.agreements[0], state.now), 3000);
  state = pay(state, id);
  state = transition(state, id, 'refund', 'owner');
  assert.equal(reserveBalance(state.agreements[0]), 0);
  assert.equal(available(state.agreements[0], 'host'), 3000);
  assert.deepEqual(restoreState(JSON.stringify(state)), state);
});
test('acknowledgment before the deadline keeps unpaid share reserved after exit', () => {
  let state = demoScenario(),
    id = state.agreements[0].id;
  state = transition(state, id, 'end', 'owner');
  state = transition(state, id, 'advance', 'demo', {
    ms: 72 * HOUR - 2
  });
  state = attest(state, id);
  state = transition(state, id, 'advance', 'demo', {
    ms: 1
  });
  assert.throws(() => transition(state, id, 'refund', 'owner'));
  state = transition(state, id, 'draw-reserve', 'host');
  assert.equal(reserveBalance(state.agreements[0]), 0);
  assert.equal(unfundedHostShare(state.agreements[0], state.now), 2000);
});
test('late grace arrival belongs to its arrival period with no post-exit minimum', () => {
  let {
    state,
    id
  } = ready();
  state = transition(state, id, 'advance', 'demo', {
    ms: PERIOD
  });
  state = transition(state, id, 'end', 'owner');
  state = transition(state, id, 'advance', 'demo', {
    ms: PERIOD
  });
  state = arrive(state, id);
  const periods = billingPeriods(state.agreements[0], state.now);
  assert.equal(periods.at(-1).minimum, 0);
  assert.equal(periods.at(-1).share, 3000);
  assert.equal(hostEntitlement(state.agreements[0], state.now), 3200);
});
test('accepted but unactivated arrivals are excluded and never reattributed after activation', () => {
  let {
    state,
    id
  } = accepted();
  state = arrive(state, id);
  assert.equal(state.agreements[0].arrivals[0].version, null);
  state = transition(state, id, 'deposit', 'owner', {
    amount: 1000
  });
  state = transition(state, id, 'pair', 'demo');
  assert.deepEqual(restoreState(JSON.stringify(state)), state);
  assert.equal(unfundedHostShare(state.agreements[0], state.now), 0);
});
test('clock advances appear in every existing agreement history and restore with exact time', () => {
  let {
    state,
    id
  } = ready();
  const next = createAgreement(state, {
    ...input,
    nft: '2049',
    wallet: 'wallet-2049'
  });
  state = next.state;
  const before = state.now;
  state = transition(state, id, 'advance', 'demo', {
    ms: PERIOD
  });
  assert.equal(state.now, before + PERIOD);
  assert.deepEqual(state.agreements[0].history.at(-1), state.agreements[1].history.at(-1));
  assert.deepEqual(restoreState(JSON.stringify(state)), state);
});
test('stable machine rules preserve terms independent of UI wording and amendments freeze price', () => {
  let {
    state,
    id
  } = ready();
  const t = currentVersion(state.agreements[0]).terms;
  assert.equal(t.rulesVersion, 1);
  assert.equal(t.billing, 'max-per-period');
  assert.equal(t.minimumBasis, 'elapsed-agreement-time');
  assert.equal(Object.hasOwn(t, 'collateralRule'), false);
  state = transition(state, id, 'amend', 'owner', {
    ownerBps: 6000,
    dailyMinimum: 999,
    securityDeposit: 999
  });
  const p = pendingVersion(state.agreements[0]).terms;
  assert.equal(p.dailyMinimum, 200);
  assert.equal(p.securityDeposit, 1000);
  assert.deepEqual(restoreState(JSON.stringify(state)), state);
});
test('restore rejects forged share draw authority, invalid allocation and premature refund', () => {
  let state = demoScenario(),
    id = state.agreements[0].id;
  state = attest(state, id);
  state = transition(state, id, 'draw-reserve', 'host');
  for (const change of [s => s.agreements[0].attestations = [], s => s.agreements[0].attestations[0].arrivalKey = 'forged', s => s.agreements[0].reserveAllocations[0].allocations[0].period = 99, s => s.agreements[0].reserveAllocations[0].amount++]) {
    const bad = structuredClone(state);
    change(bad);
    assert.throws(() => restoreState(JSON.stringify(bad)));
  }
  let x = ready();
  x.state = transition(x.state, x.id, 'end', 'owner');
  x.state = transition(x.state, x.id, 'advance', 'demo', {
    ms: 72 * HOUR
  });
  x.state = transition(x.state, x.id, 'refund', 'owner');
  const bad = structuredClone(x.state);
  bad.agreements[0].refunds[0].at = bad.agreements[0].ended.at + 1;
  assert.throws(() => restoreState(JSON.stringify(bad)));
});
test('reported transfer delay separates work stop from confirmed disconnect without extending billing or grace', () => {
  let {
    state,
    id
  } = ready();
  state = transition(state, id, 'advance', 'demo', {
    ms: 12 * HOUR
  });
  state = transition(state, id, 'transfer', 'owner');
  const a = state.agreements[0],
    minimum = serviceMinimum(a, state.now),
    deadline = graceEnd(a);
  assert.equal(a.pairing, 'transfer-pending');
  assert.equal(a.unpairedAt, null);
  assert.equal(deviceConnected(a), true);
  assert.equal(minimum, 100);
  assert.throws(() => transition(state, id, 'disconnect-transfer', 'demo'));
  assert.deepEqual(restoreState(JSON.stringify(state)), state);
  state = transition(state, id, 'advance', 'demo', {
    ms: TRANSFER_DELAY
  });
  assert.equal(state.agreements[0].pairing, 'transfer-pending');
  assert.equal(serviceMinimum(state.agreements[0], state.now), minimum);
  assert.throws(() => transition(state, id, 'disconnect-transfer', 'owner'));
  state = transition(state, id, 'disconnect-transfer', 'demo');
  assert.equal(state.agreements[0].pairing, 'revoked-by-transfer');
  assert.equal(deviceConnected(state.agreements[0]), false);
  assert.equal(graceEnd(state.agreements[0]), deadline);
  assert.equal(serviceMinimum(state.agreements[0], state.now), minimum);
  assert.deepEqual(restoreState(JSON.stringify(state)), state);
});
