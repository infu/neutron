import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const directory = import.meta.dir;
const preflight = JSON.parse(await readFile(path.join(directory,'preflight.json'),'utf8'));
const first = JSON.parse(await readFile(path.join(directory,'production-publish.json'),'utf8'));
const second = JSON.parse(await readFile(path.join(directory,'production-publish-noop.json'),'utf8'));
const changed = new Set(['evm_wallet']);
assert.notEqual(first.batch_id,null,'First release must record its atomic publication');
assert.equal(second.batch_id,null,'Postflight must be a no-op');
for(const [index,receipt] of [first,second].entries()) {
 assert.equal(receipt.protocol,'neutron-update-source-publish-v2');
 assert.equal(receipt.canister_id,preflight.updateSource);
 assert.equal(receipt.atomic,true);
 assert.equal(receipt.packages.length,preflight.packages.length);
 assert.equal(new Set(receipt.packages.map((row:any)=>row.id)).size,preflight.packages.length);
 for(const expected of preflight.packages) {
  const actual=receipt.packages.find((row:any)=>row.id===expected.id);
  assert.ok(actual,expected.id);
  for(const field of ['id','version','sha256','size']) assert.equal(actual[field],expected[field],`${expected.id}.${field}`);
  assert.equal(actual.package_path,expected.packagePath);
  assert.equal(actual.release_path,expected.releasePath);
  assert.equal(actual.status,index===0&&changed.has(expected.id)?'published':'unchanged',`${expected.id} status`);
  if(expected.source===null) assert.equal(actual.source,null);
  else {
   assert.ok(actual.source);
   for(const field of ['url','path','size','sha256']) assert.equal(actual.source[field],expected.source[field],`${expected.id}.source.${field}`);
   if(index===1||!changed.has(expected.id)) assert.equal(actual.source.status,'unchanged');
   else assert.ok(['published','unchanged'].includes(actual.source.status));
  }
 }
}
for(const p of preflight.packages) {
 for(const artifact of [p,p.source].filter(Boolean)) {
  const bytes=await readFile(artifact.file);
  assert.equal(bytes.byteLength,artifact.size,artifact.file);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),artifact.sha256,artifact.file);
 }
}
const verification={protocol:'neutron-evm-release-verification-v1',batchId:first.batch_id,postflightBatchId:second.batch_id,packages:preflight.packages.length,changed:[...changed],verifiedAt:new Date().toISOString(),allLocalBytesMatch:true};
await writeFile(path.join(directory,'receipt-verification.json'),JSON.stringify(verification,null,2)+'\n');
console.log(JSON.stringify(verification,null,2));
