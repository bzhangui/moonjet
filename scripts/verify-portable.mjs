import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {serverBinary} from '../examples/server.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const packaged=spawnSync(process.execPath,['scripts/package.mjs'],{cwd:root,encoding:'utf8',timeout:120000});
if(packaged.status!==0)throw new Error('Portable packaging failed: '+packaged.stderr);
const report=JSON.parse(packaged.stdout.trim().split(/\r?\n/).at(-1));
for(const example of ['demo.mjs','idempotent-worker.mjs']){
  const result=spawnSync(process.execPath,[path.join(report.bundle,'examples',example)],{cwd:report.bundle,env:{...process.env,NATS_SERVER:serverBinary(),MOON_BIN:'not-needed-for-portable-runtime'},encoding:'utf8',timeout:60000});
  if(result.status!==0)throw new Error('Portable demo failed: '+example+' '+result.stderr);
  const outcome=JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  if(outcome.ok!==true||outcome.real_user_pilot!==false)throw new Error('Invalid portable scenario evidence');
}
console.log(JSON.stringify({...report,portable_demos_passed:2,compiler_required_at_runtime:false}));
