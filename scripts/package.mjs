import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const built=spawnSync(process.execPath,['scripts/build.mjs'],{cwd:root,stdio:'inherit'});if(built.status!==0)throw new Error('Build failed');
const parent=path.join(root,'.local/releases');fs.mkdirSync(parent,{recursive:true});
const destination=path.join(parent,'moonjet-0.1.0-'+process.platform+'-'+process.arch+'-'+randomUUID().slice(0,8));fs.mkdirSync(destination);
const allowed=['LICENSE','NOTICE','SECURITY.md','licenses/MoonBit-Apache-2.0.txt','docs/OPERATIONS.md','scripts/console.ps1','开始使用.cmd','_build/js/release/build/cmd/bridge/bridge.js','platform/client.mjs','examples/server.mjs','examples/demo.mjs','scripts/install-server.mjs'];
const manifest={format:1,name:'MoonJet',version:'0.1.0',runtime:'Node >=22',files:{}};
const hash=b=>createHash('sha256').update(b).digest('hex');
for(const rel of allowed){const source=path.join(root,rel),target=path.join(destination,rel);if(!fs.statSync(source).isFile())throw new Error('Missing bundle file '+rel);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);manifest.files[rel]=hash(fs.readFileSync(target));}
for(const [rel,data] of [['README.md',fs.readFileSync(path.join(root,'docs/PORTABLE.md'))],['package.json',Buffer.from(JSON.stringify({name:'moonjet-portable',version:'0.1.0',private:true,type:'module'}))]]){fs.writeFileSync(path.join(destination,rel),data,{flag:'wx'});manifest.files[rel]=hash(data);}
fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
const checked=spawnSync(process.execPath,[path.join(root,'scripts/verify-package.mjs'),destination],{stdio:'inherit'});if(checked.status!==0)throw new Error('Bundle invalid');
console.log(JSON.stringify({ok:true,bundle:destination,files:Object.keys(manifest.files).length,node_bundled:false,broker_bundled:false,publicly_uploaded:false}));

