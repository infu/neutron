import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadReleaseCatalog, resolveReleaseCatalogPackageFiles } from '../../../support/update-source/src/release_catalog.ts';
import { inspectPackageFiles } from '../../../support/update-source/src/model.ts';
const root = path.resolve(import.meta.dir, '../../..');
const catalog = await loadReleaseCatalog(path.join(root, 'support/update-source/release-catalog.json'));
const inspected = await inspectPackageFiles(await resolveReleaseCatalogPackageFiles(catalog));
const result = { updateSource: catalog.updateSource, packages: inspected.map(p => ({
  file:p.file, ...p.record, packagePath:p.packagePath, releasePath:p.releasePath,
  source:p.hostedSource ? {file:p.hostedSource.file,url:p.hostedSource.url,path:p.hostedSource.path,sha256:p.hostedSource.sha256,size:p.hostedSource.size} : null,
})) };
const previous = JSON.parse(await readFile(path.join(root,'.neutron/release-receipts/evm-wallet-completion-2026-09-06/preflight.json'),'utf8'));
const changed = new Set(['kernel','evm_wallet','uniswap']);
for(const p of result.packages) {
  if(changed.has(p.id)) {
    const old = previous.packages.find((item:any) => item.id === p.id);
    if(!old || p.version <= old.version) throw new Error(`Expected strictly higher successor: ${p.id}`);
    if(p.sha256 === old.sha256) throw new Error(`Expected changed successor bytes: ${p.id}`);
    continue;
  }
  const old = previous.packages.find((item:any) => item.id === p.id);
  if(!old || JSON.stringify(p) !== JSON.stringify(old)) throw new Error(`Unexpected package/source change: ${p.id}`);
}
if(result.packages.length !== 18) throw new Error('Expected eighteen reviewed package/source pairs');
await writeFile(path.join(import.meta.dir,'preflight.json'), JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
