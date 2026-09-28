// v0.3 invariant campaign, adapted from Claude's v0.2 action-fuzz idea.
// Does not run workers, wallets, browser automation, or network requests.
import assert from 'node:assert/strict';
import {initialState,createAgreement,transition,termsKey,pendingVersion,available,unfundedHostShare,collectibleDue,arrivalKey,billingPeriods,graceEnd,restoreState,HOUR,PAYER,reserveBalance,serviceMinimum,hostEntitlement,unsecuredExposure} from '../dist/model.js';
let seed=Number(process.argv[2]||3)>>>0;const initialSeed=seed;
const rnd=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
const pick=xs=>xs[Math.floor(rnd()*xs.length)];
const total=xs=>xs.reduce((n,r)=>n+r.amount,0);
let steps=0;const applied={};
const actions=['approve','approve','amend','discard','pair','advance','advance','arrive','arrive','pay','pay','attest','attest','deposit','draw-reserve','draw-reserve','refund','withdraw','end','unlink','transfer','disconnect-transfer','recovery','review'];
const roles={pair:'demo',advance:'demo',arrive:'demo',pay:'owner',attest:'owner',deposit:'owner','draw-reserve':'host',refund:'owner',withdraw:'host',unlink:'host',transfer:'owner','disconnect-transfer':'demo',recovery:'owner',review:'owner'};
for(let run=0;run<3000;run++){
  let {state,id}=createAgreement(initialState(),{hostId:pick(['northstar','relay','harbor']),nft:'2048',ownerBps:100*(1+Math.floor(rnd()*99)),wallet:'wallet-'+run,dedicatedWallet:true});
  if(run%2===0){
    for(const role of ['owner','host'])state=transition(state,id,'approve',role,{version:1,termsKey:termsKey(state.agreements[0].versions[0])});
    const deposit=state.agreements[0].host.securityDeposit;
    if(deposit)state=transition(state,id,'deposit','owner',{amount:deposit});
    state=transition(state,id,'pair','demo');
  }
  if(run%5===0)state=createAgreement(state,{hostId:'northstar',nft:'2049',ownerBps:7000,wallet:'second-'+run,dedicatedWallet:true}).state;
  for(let i=0;i<60;i++){
    const a=state.agreements[0],action=pick(actions),role=roles[action]??pick(['owner','host']);let payload={};
    if(action==='approve'){const v=pendingVersion(a);payload={version:v?.number,termsKey:v?termsKey(v):''};}
    if(action==='amend')payload={ownerBps:100*(1+Math.floor(rnd()*99))};
    if(action==='advance')payload={ms:pick([1,HOUR,12*HOUR,24*HOUR-1,24*HOUR,72*HOUR,5*24*HOUR])};
    if(action==='arrive')payload={arrivalId:'ar-'+run+'-'+i,amount:pick([1,3,101,10000,12345,99999999]),payer:rnd()<0.85?PAYER:'other',wallet:rnd()<0.9?a.wallet:'other-wallet'};
    if(action==='pay')payload={amount:pick([1,100,1000,unfundedHostShare(a,state.now)])};
    if(action==='attest'){const candidates=a.arrivals.filter(r=>r.version!==null&&!a.attestations.some(t=>t.arrivalId===r.id));const r=candidates.length?pick(candidates):null;payload={arrivalId:r?.id,arrivalKey:r?arrivalKey(r):''};}
    if(action==='deposit')payload={amount:pick([1,200,a.host.securityDeposit||1,1000,5000])};
    if(action==='review')payload={rating:1+Math.floor(rnd()*5),comment:'A sufficiently long example service review.'};
    let next;try{next=transition(state,id,action,role,payload);}catch{continue;}
    try{
      const b=next.agreements[0];
      assert.equal(total(b.deposits)+total(b.payments),total(b.withdrawals)+total(b.refunds)+reserveBalance(b)+available(b,'host'),'cash conservation');
      assert.ok(reserveBalance(b)>=0&&available(b,'host')>=0,'nonnegative balances');
      assert.equal(available(b,'owner'),0,'owner has no reward claim');
      assert.equal(unsecuredExposure(b,next.now),Math.max(0,unfundedHostShare(b,next.now)-reserveBalance(b)));
      assert.ok(collectibleDue(b,next.now)<=unfundedHostShare(b,next.now),'authority does not exceed observed debt');
      assert.ok(total(b.payments)+total(b.reserveAllocations)<=hostEntitlement(b,next.now),'no overpayment');
      for(const p of billingPeriods(b,next.now))assert.ok(p.funded<=p.entitlement,'no period prepayment');
      if(action==='draw-reserve')assert.ok(b.reserveAllocations.at(-1).amount<=collectibleDue(a,next.now),'draw requires authority');
      if(action==='refund'){
        assert.ok(a.ended&&state.now>=graceEnd(a),'refund window');
        assert.equal(b.refunds.at(-1).amount,Math.max(0,reserveBalance(a)-collectibleDue(a,state.now)),'refund keeps authorized debt reserved');
      }
      if(b.ended)assert.equal(serviceMinimum(b,next.now),serviceMinimum(b,next.now+30*24*HOUR),'minimum frozen at exit');
      assert.equal(JSON.stringify(restoreState(JSON.stringify(next))),JSON.stringify(next),'exact restore');
    }catch(error){console.error(JSON.stringify({seed:initialSeed,run,step:i,action,role,payload,error:error.message}));process.exit(1);}
    state=next;steps++;applied[action]=(applied[action]||0)+1;
  }
}
console.log(JSON.stringify({seed:initialSeed,runs:3000,steps,applied,failures:0},null,2));
