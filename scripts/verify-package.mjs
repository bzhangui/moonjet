import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=path.resolve(process.argv[2]||'');if(!process.argv[2]||!fs.lstatSync(root).isDirectory()||fs.lstatSync(root).isSymbolicLink())throw new Error('Pass real bundle directory');
const file=path.join(root,'manifest.json'),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1048576)throw new Error('Invalid manifest');
const manifest=JSON.parse(fs.readFileSync(file,'utf8'));if(manifest.format!==1||!manifest.files||typeof manifest.files!=='object'||Array.isArray(manifest.files)||Object.keys(manifest.files).length>64)throw new Error('Invalid bundle manifest');
for(const [rel,expected]of Object.entries(manifest.files)){if(!rel||rel.includes("\\")||rel.includes(":")||[...rel].some(c=>c.charCodeAt(0)<32)||path.isAbsolute(rel)||rel.split('/').some(p=>!p||p==='.'||p==='..')||!(/^[0-9a-f]{64}$/.test(expected)))throw new Error('Unsafe bundle record');let part=root;for(const token of rel.split('/')){part=path.join(part,token);if(fs.lstatSync(part).isSymbolicLink())throw new Error('Bundle link');}const stat=fs.lstatSync(part);if(!stat.isFile()||stat.nlink!==1||stat.size>16777216)throw new Error('Bundle file invalid');if(createHash('sha256').update(fs.readFileSync(part)).digest('hex')!==expected)throw new Error('Bundle hash mismatch');}
console.log(JSON.stringify({verified:true,signed:false,files:Object.keys(manifest.files).length}));

