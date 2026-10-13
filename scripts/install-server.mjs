import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const version='2.15.1',platform=process.platform==='win32'?'windows':process.platform,arch={x64:'amd64',arm64:'arm64'}[process.arch];
if(!arch||!['windows','linux','darwin'].includes(platform))throw new Error('Unsupported broker platform');
const folder=`nats-server-v${version}-${platform}-${arch}`,extension=platform==='windows'?'zip':'tar.gz';
const parent=path.join(root,'.local/tools'),binary=path.join(parent,folder,'nats-server'+(platform==='windows'?'.exe':''));
if(fs.existsSync(binary)){const probe=spawnSync(binary,['--version'],{encoding:'utf8'});if(probe.status!==0||!probe.stdout.includes('v'+version))throw new Error('Existing broker version differs');console.log('Verified installed NATS '+version);process.exit(0);}
async function download(url,limit){const response=await fetch(url,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw new Error('Official release download failed');const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw new Error('Release byte budget exceeded');chunks.push(chunk);}return Buffer.concat(chunks);}
const origin=`https://github.com/nats-io/nats-server/releases/download/v${version}`,name=folder+'.'+extension;
const sums=(await download(origin+'/SHA256SUMS',1048576)).toString('utf8'),row=sums.split(/\r?\n/).find(line=>line.trim().endsWith(' '+name));if(!row)throw new Error('Missing official checksum');
const bytes=await download(origin+'/'+name,67108864),hash=createHash('sha256').update(bytes).digest('hex');if(hash!==row.trim().split(/\s+/)[0])throw new Error('Release checksum mismatch');
fs.mkdirSync(parent,{recursive:true});const archive=path.join(parent,'download-'+randomUUID()+'.'+extension);fs.writeFileSync(archive,bytes,{flag:'wx'});
const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',maxBuffer:1048576,windowsHide:true});if(result.error||result.status!==0)throw new Error('Broker extraction failed');return result.stdout;};
const escape=value=>value.replaceAll("'","''");
let entries;
if(platform==='windows')entries=JSON.parse(run('powershell.exe',['-NoProfile','-Command',`Add-Type -AssemblyName System.IO.Compression.FileSystem; $archive=[IO.Compression.ZipFile]::OpenRead('${escape(archive)}'); try { @($archive.Entries | ForEach-Object { $_.FullName }) | ConvertTo-Json -Compress } finally { $archive.Dispose() }`]));
else entries=run('tar',['-tzf',archive]).trim().split(/\r?\n/);
if(!Array.isArray(entries)||entries.length>64||entries.some(entry=>!entry.startsWith(folder+'/')||entry.includes('\\')||entry.includes(':')||entry.split('/').includes('..')))throw new Error('Unsafe release archive path');
if(platform==='windows')run('powershell.exe',['-NoProfile','-Command',`Expand-Archive -LiteralPath '${escape(archive)}' -DestinationPath '${escape(parent)}'`]);else run('tar',['-xzkf',archive,'-C',parent]);
const probe=run(binary,['--version']);if(!probe.includes('v'+version))throw new Error('Extracted broker version differs');
fs.writeFileSync(path.join(parent,'release-verification.json'),JSON.stringify({version,source:origin+'/'+name,sha256:hash},null,2));console.log('Installed checksum-verified NATS '+version+' for isolated tests; not included in public source');
