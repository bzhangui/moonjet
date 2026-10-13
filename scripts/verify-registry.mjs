import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {moon,moonEnv} from './build.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const parent=path.join(root,'.local/registry-consumers');fs.mkdirSync(parent,{recursive:true});
const consumer=path.join(parent,randomUUID());fs.mkdirSync(consumer);
fs.writeFileSync(path.join(consumer,'moon.mod'),'name = "verification/moonjet"\nversion = "0.0.0"\n',{flag:'wx'});
fs.copyFileSync(path.join(root,'examples/core/moon.pkg'),path.join(consumer,'moon.pkg'),fs.constants.COPYFILE_EXCL);
fs.copyFileSync(path.join(root,'examples/core/main.mbt'),path.join(consumer,'main.mbt'),fs.constants.COPYFILE_EXCL);
function run(args){const result=spawnSync(moon,args,{cwd:consumer,env:moonEnv,stdio:'inherit'});if(result.error||result.status!==0)throw new Error('Independent registry consumer failed: '+args.join(' '));}
run(['add','bzhangui/moonjet@0.1.0']);
for(const target of ['js','wasm','wasm-gc','native']){run(['check','--target',target,'--deny-warn']);run(['build','--target',target,'--release','--deny-warn']);run(['run','.', '--target',target]);}
fs.writeFileSync(path.join(consumer,'verification.json'),JSON.stringify({module:'bzhangui/moonjet',version:'0.1.0',registry_dependency:true,local_source_copy:false,targets:['js','wasm','wasm-gc','native'],ok:true},null,2),{flag:'wx'});
console.log(JSON.stringify({ok:true,module:'bzhangui/moonjet@0.1.0',consumer}));

