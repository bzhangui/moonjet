import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(change){
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'moonjet-bundle-test-'));
  try{
    fs.writeFileSync(path.join(dir,'payload.txt'),'safe fixture');
    const manifest={format:1,name:'MoonJet',version:'0.1.0',files:{'payload.txt':hash('safe fixture')}};
    change?.(dir,manifest);
    fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest));
    return spawnSync(process.execPath,[path.join(root,'scripts/verify-package.mjs'),dir],{encoding:'utf8',timeout:10000});
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
test('bundle verifies exact file set and hashes',()=>{const result=fixture();assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).signed,false);});
test('bundle rejects changed bytes',()=>{assert.notEqual(fixture(dir=>fs.writeFileSync(path.join(dir,'payload.txt'),'corrupted')).status,0);});
test('bundle rejects traversal record',()=>{assert.notEqual(fixture((dir,m)=>{m.files['../outside']=hash('x');}).status,0);});
test('bundle rejects unlisted private file and folder',()=>{assert.notEqual(fixture(dir=>fs.writeFileSync(path.join(dir,'.env'),'synthetic-only')).status,0);assert.notEqual(fixture(dir=>fs.mkdirSync(path.join(dir,'unlisted'))).status,0);});
test('bundle rejects empty or wrong module manifest',()=>{assert.notEqual(fixture((dir,m)=>{m.files={};}).status,0);assert.notEqual(fixture((dir,m)=>{m.name='wrong-module';}).status,0);});
test('Windows launcher preserves Chinese text and source-only maintenance guard',()=>{
  const bytes=fs.readFileSync(path.join(root,'scripts/console.ps1'));assert.deepEqual([...bytes.subarray(0,3)],[239,187,191]);
  assert.ok(bytes.toString('utf8').includes('运行包不包含开发测试'));
  assert.ok(fs.readFileSync(path.join(root,'开始使用.cmd'),'utf8').includes('-NoProfile'));
});

