import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const projectRoot=fileURLToPath(new URL('../',import.meta.url));
export const minimumCompiler='0.10.15';
export function supportedCompiler(output){
  const match=output.match(/\bmoonc v(\d+)\.(\d+)\.(\d+)(?:[-+][^\s]+)?(?:\s|$)/);
  if(!match)return false;
  const [major,minor,patch]=match.slice(1).map(Number);
  return major>0||minor>10||(minor===10&&patch>=15);
}

// Private configuration is explicit, never guessed from sibling projects.
// An invalid configured path fails closed instead of silently selecting PATH.
export function resolveToolchain({root=projectRoot,env=process.env,platform=process.platform}={}){
  const settings=path.join(root,'.local','toolchain.json');
  const local=path.join(root,'.local','toolchain','bin',platform==='win32'?'moon.exe':'moon');
  let moon,source;
  if(env.MOON_BIN){moon=env.MOON_BIN;source='environment';}
  else if(fs.existsSync(settings)){
    const stat=fs.lstatSync(settings);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw new Error('Invalid private toolchain configuration');
    let config;
    try{config=JSON.parse(fs.readFileSync(settings,'utf8'));}catch{throw new Error('Invalid private toolchain JSON; reconfigure with npm run toolchain -- --moon <absolute-path>');}
    if(!config||config.format!==1||typeof config.moon!=='string'||!path.isAbsolute(config.moon)||Object.keys(config).some(key=>!['format','moon'].includes(key)))throw new Error('Invalid private toolchain configuration');
    moon=config.moon;source='configuration';
    if(!fs.existsSync(moon)||!fs.statSync(moon).isFile())throw new Error('Configured MoonBit executable missing; reconfigure with npm run toolchain -- --moon <absolute-path>');
  }else if(fs.existsSync(local)){moon=local;source='project-local';}
  else{moon=platform==='win32'?'moon.exe':'moon';source='PATH';}
  if(typeof moon!=='string'||/[\0\r\n]/.test(moon))throw new Error('Invalid MoonBit executable');
  const home=path.isAbsolute(moon)&&path.basename(path.dirname(moon))==='bin'?path.dirname(path.dirname(moon)):null;
  const moonEnv={...env};
  if(home&&(source!=='environment'||!env.MOON_HOME))moonEnv.MOON_HOME=home;
  return {moon,moonEnv,source};
}

export function probeToolchain(selection,{spawn=spawnSync}={}){
  const result=spawn(selection.moon,['version','--all'],{encoding:'utf8',env:selection.moonEnv,shell:false,windowsHide:true,timeout:15000,maxBuffer:65536});
  if(result.error||result.status!==0)throw new Error('MoonBit unavailable. Install moonc >= '+minimumCompiler+' or run npm run toolchain -- --moon <absolute-path>');
  if(!supportedCompiler(result.stdout||''))throw new Error('MoonBit >= '+minimumCompiler+' required; run npm run toolchain -- --moon <absolute-path> (global installation is not changed)');
  return {version:result.stdout.trim(),source:selection.source};
}

export function configureToolchain(executable,{root=projectRoot,env=process.env,probe=probeToolchain}={}){
  if(typeof executable!=='string'||!path.isAbsolute(executable)||/[\0\r\n]/.test(executable))throw new Error('Pass an absolute MoonBit executable path');
  if(!fs.existsSync(executable)||!fs.statSync(executable).isFile())throw new Error('MoonBit executable does not exist');
  const selection=resolveToolchain({root,env:{...env,MOON_BIN:executable,MOON_HOME:''}});
  const result=probe(selection);
  fs.mkdirSync(path.join(root,'.local'),{recursive:true});
  const settings=path.join(root,'.local','toolchain.json');
  if(fs.existsSync(settings)&&(!fs.lstatSync(settings).isFile()||fs.lstatSync(settings).isSymbolicLink()))throw new Error('Refusing non-regular toolchain configuration');
  fs.writeFileSync(settings,JSON.stringify({format:1,moon:executable},null,2)+'\n',{mode:0o600});
  return {...result,source:'configuration'};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  const result=args.length===0||args.length===1&&args[0]==='--check'
    ?probeToolchain(resolveToolchain())
    :args.length===2&&args[0]==='--moon'
      ?configureToolchain(args[1])
      :(()=>{throw new Error('Usage: node scripts/toolchain.mjs [--check | --moon <absolute-path>]');})();
  console.log(result.version);
  console.log('Toolchain source: '+result.source+'; private configuration only, no global changes.');
}
