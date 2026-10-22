import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const local=path.join(root,'.local','toolchain','bin',process.platform==='win32'?'moon.exe':'moon');
export const moon=process.env.MOON_BIN||(fs.existsSync(local)?local:(process.platform==='win32'?'moon.exe':'moon'));
export const moonEnv={...process.env,...(fs.existsSync(local)&&!process.env.MOON_BIN?{MOON_HOME:path.dirname(path.dirname(local))}:{})};
export function run(cmd,args){const r=spawnSync(cmd,args,{cwd:root,env:moonEnv,stdio:'inherit',shell:false});if(r.error)throw r.error;if(r.status!==0)throw new Error('Command failed: '+cmd+' '+args.join(' '));}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major<22||(major===22&&minor<13))throw new Error('Node.js >= 22.13 required (SQLite example uses node:sqlite)');
  const v=spawnSync(moon,['version','--all'],{encoding:'utf8',env:moonEnv});if(v.status!==0||!(/moonc v0\.10\.(1[5-9]|[2-9][0-9])\b|moonc v0\.(1[1-9]|[2-9][0-9])\.|moonc v[1-9]\./.test(v.stdout)))throw new Error('MoonBit >= 0.10.15 required');
  run(moon,['update']);run(moon,['build','--target','js','--release','--deny-warn']);
}
