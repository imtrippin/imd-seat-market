// Round-three review: local fixtures and command shims only. Intentional failures document findings.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,existsSync,chmodSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const here=dirname(fileURLToPath(import.meta.url));
const pairing=resolve(here,'../../contracts/script/pair-vault.mjs');
const walkthrough=resolve(here,'../../contracts/script/testnet-walkthrough.sh');
const source=readFileSync(pairing,'utf8');
const stop=source.indexOf('if (has("--selftest"))');
assert.ok(stop>0);
// Import unchanged pure helper definitions, without running the script's CLI branches.
const {validateArtifact,expiryProblems,typedData,completionBody}=await import('data:text/javascript,'+encodeURIComponent(source.slice(0,stop)));
const T0=1_800_000_000;
const good=()=>({createdAt:T0,code:'ABCD1234',chain:1,collection:'0x'+'12'.repeat(20),vault:'0x'+'ab'.repeat(20),message:{deviceKey:'0x'+'cd'.repeat(32),wallet:'0x'+'ab'.repeat(20),tokenId:'42',nonce:'0x'+'ef'.repeat(32),expiresAt:T0+600,relayOrigin:'https://relay.invalid'},codeExpiresAt:T0+300});

test('R3-1: a uint256-overflow token id must fail artifact validation',()=>{
  const a=good();a.message.tokenId=(1n<<256n).toString();
  assert.notEqual(validateArtifact(a).length,0,'2^256 cannot be encoded as uint256 but passes the full validator');
});
test('R3-1: a numeric token id must not leak into a string-only completion field',()=>{
  const a=good();a.message.tokenId=42;
  assert.notEqual(validateArtifact(a).length,0,'numeric id accepted; body sends JSON number instead of decimal string');
  assert.equal(typeof completionBody(a,'0x00').message.tokenId,'string');
});
test('uint64 overflow and unsafe JS integers are refused; uint256 max string is accepted',()=>{
  for(const value of [Number(1n<<64n),Number.MAX_SAFE_INTEGER+1,T0+.5,'1800000600']){
    const a=good();a.message.expiresAt=value;assert.notEqual(validateArtifact(a).length,0);
  }
  const a=good();a.message.tokenId=((1n<<256n)-1n).toString();
  assert.deepEqual(validateArtifact(a),[]);assert.equal(typedData(a).message.tokenId,(1n<<256n)-1n);
});
test('hex is lowercase and prefixed; message wallet must be lowercase vault',()=>{
  for(const [field,value] of [['nonce','0x'+'EF'.repeat(32)],['deviceKey','cd'.repeat(32)],['wallet','0x'+'AB'.repeat(20)]]){
    const a=good();a.message[field]=value;assert.notEqual(validateArtifact(a).length,0);
  }
});
test('both clocks are exclusive at their deadline and unknown code expiry stays explicit',()=>{
  const a=good();assert.deepEqual(expiryProblems(a,T0+299),[]);
  assert.equal(expiryProblems(a,T0+300).length,1);
  a.codeExpiresAt=null;assert.deepEqual(expiryProblems(a,T0+599),[]);
  assert.equal(expiryProblems(a,T0+600).length,1);
});
test('scope witness: schema validation cannot attest the vault chain or approved digest',()=>{
  const a=good();a.chain=84532; // no RPC/vault supplied to validation
  assert.deepEqual(validateArtifact(a),[]);
  a.message.expiresAt=T0+7200;
  assert.deepEqual(validateArtifact(a),[]);
  assert.deepEqual(expiryProblems(a,T0),[]);
});

const bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'/bin/bash';
const bashPath=p=>p.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,d)=>'/'+d.toLowerCase());
function scratch(work){const folder=mkdtempSync(join(here,'.round3-scratch-'));try{return work(folder)}finally{const target=resolve(folder);assert.ok(target.startsWith(resolve(here)+sep)&&target.includes('.round3-scratch-'));rmSync(target,{recursive:true,force:true})}}
function scenario(folder,mode){
  const code=readFileSync(walkthrough,'utf8');
  const start=code.indexOf('receipt() {'),end=code.indexOf('call() {',start);assert.ok(start>=0&&end>start);
  const twice=mode==='two-calls'?"\nsend PUBLIC_REVIEW_MARKER token 'transfer(address,uint256)' recipient 100\n":'';
  writeFileSync(join(folder,'harness.sh'),`#!/usr/bin/env bash\nset -euo pipefail\nRPC=https://review.invalid\nSETTLE=0\n${code.slice(start,end)}\nsend PUBLIC_REVIEW_MARKER token 'transfer(address,uint256)' recipient 100\n${twice}`);
  writeFileSync(join(folder,'cast'),`#!/usr/bin/env bash
echo "$1" >> "$REVIEW_DIR/journal"
for arg in "$@"; do last="$arg"; done
case "$1" in
 wallet) echo 0x1111111111111111111111111111111111111111 ;;
 nonce) if [ "$REVIEW_MODE" = nonce-error ]; then echo 'unavailable' >&2; exit 1; fi; echo 7 ;;
 mktx)
   value=unset
   while [ "$#" -gt 0 ]; do if [ "$1" = --nonce ]; then shift; value="$1"; fi; shift; done
   echo "nonce=$value" >> "$REVIEW_DIR/journal"
   # Foundry 1.8.3 accepts an empty --nonce as zero; the separate native CLI probe confirms this.
   if [ -z "$value" ]; then value=0; fi
   echo "raw-$value" ;;
 keccak) echo "hash-$last" ;;
 publish)
   echo "bytes=$last" >> "$REVIEW_DIR/journal"
   if [ "$REVIEW_MODE" = stale ]; then echo 'nonce too low'; exit 1; fi
   if [ "$REVIEW_MODE" = wrong-publish ]; then echo other-hash; else echo "hash-$last"; fi ;;
 receipt)
   if [ "$REVIEW_MODE" = stale ] || [ "$REVIEW_MODE" = wrong-publish ]; then echo null;
   elif [ "$REVIEW_MODE" = wrong-receipt ]; then echo '{"transactionHash":"other-hash","status":"0x1","blockNumber":"0x1"}';
   else echo "{\\"transactionHash\\":\\"$last\\",\\"status\\":\\"0x1\\",\\"blockNumber\\":\\"0x1\\"}"; fi ;;
 *) exit 99 ;;
esac
`);
  // Run the real production Python parser, not a stub that might conceal future hash checks.
  assert.ok(process.env.REVIEW_PYTHON,'Set REVIEW_PYTHON to a Python executable for the offline receipt probes.');
  writeFileSync(join(folder,'python'),'#!/usr/bin/env bash\nexec "$REVIEW_PYTHON" "$@"\n');
  writeFileSync(join(folder,'sleep'),'#!/usr/bin/env bash\nexit 0\n');
  for(const name of ['cast','python','sleep','harness.sh'])chmodSync(join(folder,name),0o755);
  const r=spawnSync(bash,['--noprofile','--norc','-c','export PATH="$REVIEW_DIR:$PATH"; exec bash "$REVIEW_DIR/harness.sh"'],{encoding:'utf8',timeout:15000,env:{...process.env,REVIEW_DIR:bashPath(folder),REVIEW_MODE:mode,REVIEW_PYTHON:bashPath(process.env.REVIEW_PYTHON)}});
  assert.equal(r.error,undefined);
  return {...r,journal:readFileSync(join(folder,'journal'),'utf8').trim().split(/\r?\n/)};
}
test('R3-2: a status-1 receipt for another hash must not confirm this call',{skip:!existsSync(bash)},()=>scratch(folder=>{
  const r=scenario(folder,'wrong-receipt');
  assert.equal(r.journal.filter(x=>x==='mktx').length,1);
  assert.notEqual(r.status,0,'wrong transactionHash accepted as success');
}));
test('R3-3: a failed nonce read must stop before invoking signing',{skip:!existsSync(bash)},()=>scratch(folder=>{
  const r=scenario(folder,'nonce-error');
  assert.notEqual(r.status,0,'failed nonce query was converted to a successful simulated nonce-zero send');
  assert.ok(!r.journal.includes('publish'),'must never publish with an empty nonce');
  assert.ok(!r.journal.includes('mktx'),'next_nonce swallowed cast failure and reached signing with an empty value');
}));
const castMissing=spawnSync('cast',['--version'],{encoding:'utf8'}).status!==0;
test('Foundry 1.8.3 witness: empty nonce signs as zero using a public test key, without RPC',{skip:castMissing&&'cast (Foundry) is not on PATH'},()=>{
  const key='0x'+'0'.repeat(63)+'1'; // public fixture, never use for funds
  const r=spawnSync('cast',['mktx','--nonce','','--gas-limit','21000','--gas-price','1','--chain','84532','--legacy',
    '--private-key',key,'--rpc-url','http://127.0.0.1:9','0x'+'11'.repeat(20)],{encoding:'utf8',timeout:15000});
  assert.equal(r.status,0,'local public-fixture transaction build failed');
  const decoded=spawnSync('cast',['decode-transaction',r.stdout.trim()],{encoding:'utf8',timeout:15000});
  assert.equal(decoded.status,0);
  let tx=JSON.parse(decoded.stdout);if(typeof tx==='string')tx=JSON.parse(tx);
  assert.equal(tx.nonce,'0x0');
  assert.equal(tx.chainId,'0x14a34');
});
for(const mode of ['stale','wrong-publish'])test(`${mode}: missing local-hash receipt stops without a second transaction`,{skip:!existsSync(bash)},()=>scratch(folder=>{
  const r=scenario(folder,mode);assert.notEqual(r.status,0);
  assert.equal(r.journal.filter(x=>x==='mktx').length,1);
  assert.equal(new Set(r.journal.filter(x=>x.startsWith('bytes='))).size,1);
  assert.match(r.stdout,/no receipt for hash-raw-7/);
}));
test('two successful calls read the key nonce once and advance it locally',{skip:!existsSync(bash)},()=>scratch(folder=>{
  const r=scenario(folder,'two-calls');assert.equal(r.status,0);
  assert.equal(r.journal.filter(x=>x==='nonce').length,1);
  assert.deepEqual(r.journal.filter(x=>x.startsWith('nonce=')),['nonce=7','nonce=8']);
}));
