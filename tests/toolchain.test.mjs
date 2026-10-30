import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {supportedCompiler,resolveToolchain,probeToolchain,configureToolchain} from '../scripts/toolchain.mjs';

function fixture(fn){
  const parent=fs.realpathSync(os.tmpdir());
  const root=fs.mkdtempSync(path.join(parent,'moonjet-toolchain-test-'));
  const executable=path.join(root,'isolated sdk','bin',process.platform==='win32'?'moon.exe':'moon');
  fs.mkdirSync(path.dirname(executable),{recursive:true});fs.writeFileSync(executable,'not executable, never run');
  try{return fn({root,executable,settings:path.join(root,'.local','toolchain.json')});}
  finally{assert.equal(path.dirname(root),parent);assert.ok(path.basename(root).startsWith('moonjet-toolchain-test-'));fs.rmSync(root,{recursive:true,force:true});}
}

test('compiler gate compares complete version components, including future releases',()=>{
  for(const value of ['0.10.16','0.10.18','0.10.100','0.11.0','0.100.0','1.0.0','2.3.4'])assert.equal(supportedCompiler('moon v0.1\nmoonc v'+value+' (build)'),true,value);
  for(const value of ['0.10.15','0.10.14','0.9.100','0.1.999'])assert.equal(supportedCompiler('moonc v'+value+' (build)'),false,value);
  assert.equal(supportedCompiler('moon v0.10.15\nno compiler version'),false);
  assert.equal(supportedCompiler('moonc v0.10.15oops'),false);
});

test('explicit environment overrides private configuration and infers matching SDK home',()=>fixture(({root,executable,settings})=>{
  fs.mkdirSync(path.dirname(settings),{recursive:true});fs.writeFileSync(settings,'invalid JSON is not selected');
  const selected=resolveToolchain({root,env:{MOON_BIN:executable}});
  assert.equal(selected.moon,executable);assert.equal(selected.source,'environment');assert.equal(selected.moonEnv.MOON_HOME,path.dirname(path.dirname(executable)));
  assert.equal(resolveToolchain({root,env:{MOON_BIN:executable,MOON_HOME:'explicit-home'}}).moonEnv.MOON_HOME,'explicit-home');
}));

test('private configuration uses matching home and does not inherit a different global home',()=>fixture(({root,executable,settings})=>{
  fs.mkdirSync(path.dirname(settings),{recursive:true});fs.writeFileSync(settings,JSON.stringify({format:1,moon:executable}));
  const selected=resolveToolchain({root,env:{MOON_HOME:'old-global-home'}});
  assert.equal(selected.source,'configuration');assert.equal(selected.moon,executable);assert.equal(selected.moonEnv.MOON_HOME,path.dirname(path.dirname(executable)));
}));

test('invalid private configuration fails closed instead of silently falling back to PATH',()=>fixture(({root,executable,settings})=>{
  fs.mkdirSync(path.dirname(settings),{recursive:true});
  for(const source of ['{',JSON.stringify({format:1,moon:'relative/moon'}),JSON.stringify({format:1,moon:executable,token:'not-real'}),JSON.stringify({format:1,moon:path.join(root,'missing')})]){
    fs.writeFileSync(settings,source);assert.throws(()=>resolveToolchain({root,env:{}}),/configuration|JSON|missing/);
  }
  fs.writeFileSync(settings,' '.repeat(16385));assert.throws(()=>resolveToolchain({root,env:{}}),/configuration/);
}));

test('unconfigured project chooses its own SDK before PATH without mutating environment',()=>fixture(({root})=>{
  const env={MOON_HOME:'unchanged'};const fallback=resolveToolchain({root,env});assert.equal(fallback.source,'PATH');
  const local=path.join(root,'.local','toolchain','bin',process.platform==='win32'?'moon.exe':'moon');
  fs.mkdirSync(path.dirname(local),{recursive:true});fs.writeFileSync(local,'fixture');
  assert.equal(resolveToolchain({root,env}).source,'project-local');assert.deepEqual(env,{MOON_HOME:'unchanged'});
}));

test('toolchain probe is bounded, shell-free and rejects missing or old compiler',()=>{
  const selection={moon:'moon',moonEnv:{test:'value'},source:'PATH'};let called=false;
  const result=probeToolchain(selection,{spawn:(cmd,args,options)=>{called=true;assert.equal(cmd,'moon');assert.deepEqual(args,['version','--all']);assert.equal(options.shell,false);assert.equal(options.timeout,15000);assert.equal(options.env,selection.moonEnv);return {status:0,stdout:'moonc v0.10.18 (fixture)\n'};}});
  assert.ok(called);assert.equal(result.source,'PATH');
  for(const outcome of [{status:0,stdout:'moonc v0.10.14 (old)'},{status:1},{error:new Error('missing')},{status:0,stdout:'unexpected'}])assert.throws(()=>probeToolchain(selection,{spawn:()=>outcome}),/toolchain|MoonBit/);
});

test('toolchain configuration validates before writing, keeps paths private and never changes globals',()=>fixture(({root,executable,settings})=>{
  const env={MOON_BIN:'different',MOON_HOME:'global-home'};
  assert.throws(()=>configureToolchain('relative',{root,env}),/absolute/);
  assert.throws(()=>configureToolchain(executable,{root,env,probe:()=>{throw new Error('old compiler');}}),/old compiler/);
  assert.equal(fs.existsSync(settings),false);
  const result=configureToolchain(executable,{root,env,probe:selection=>{assert.equal(selection.moon,executable);assert.equal(selection.moonEnv.MOON_HOME,path.dirname(path.dirname(executable)));return {version:'moonc v0.10.15'};}});
  assert.equal(result.source,'configuration');assert.deepEqual(JSON.parse(fs.readFileSync(settings,'utf8')),{format:1,moon:executable});
  assert.deepEqual(env,{MOON_BIN:'different',MOON_HOME:'global-home'});assert.equal(resolveToolchain({root,env:{}}).moon,executable);
}));
