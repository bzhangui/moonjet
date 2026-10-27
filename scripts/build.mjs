import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {projectRoot as root,resolveToolchain,probeToolchain} from './toolchain.mjs';
const selection=resolveToolchain();
export const {moon,moonEnv}=selection;
export function run(cmd,args){const r=spawnSync(cmd,args,{cwd:root,env:moonEnv,stdio:'inherit',shell:false});if(r.error)throw r.error;if(r.status!==0)throw new Error('Command failed: '+cmd+' '+args.join(' '));}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major<22||(major===22&&minor<13))throw new Error('Node.js >= 22.13 required (SQLite example uses node:sqlite)');
  probeToolchain(selection);
  run(moon,['update']);run(moon,['build','--target','js','--release','--deny-warn']);
}
