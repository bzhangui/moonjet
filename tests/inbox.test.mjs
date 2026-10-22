import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {InboxStore} from '../examples/inbox-store.mjs';

test('inbox example commits effect and key together, survives reopen, rejects conflicting retries',()=>{
  const parent=fs.realpathSync(os.tmpdir()),folder=fs.mkdtempSync(path.join(parent,'moonjet-inbox-'));let store;
  try{
    const file=path.join(folder,'fixture.sqlite');store=new InboxStore(file);
    assert.equal(store.apply({eventId:'owned-1',amount:3}),true);assert.equal(store.apply({eventId:'owned-1',amount:3}),false);
    assert.throws(()=>store.apply({eventId:'owned-2',amount:5},{failBeforeCommit:true}),/Controlled/);
    assert.deepEqual(store.snapshot(),{events:1,total:3});store.close();store=new InboxStore(file);
    assert.equal(store.apply({eventId:'owned-1',amount:3}),false);assert.throws(()=>store.apply({eventId:'owned-1',amount:4}),/conflict/);
    assert.equal(store.apply({eventId:'owned-2',amount:5}),true);assert.deepEqual(store.snapshot(),{events:2,total:8});
  }finally{store?.close();if(path.dirname(path.resolve(folder))!==parent||!path.basename(folder).startsWith('moonjet-inbox-'))throw new Error('Unsafe fixture cleanup');fs.rmSync(folder,{recursive:true,force:true});}
});
test('inbox validates event keys, amount budget and cannot inject SQLite statements',()=>{
  const store=new InboxStore(':memory:');
  try{
    for(const event of [null,{},[],{eventId:'',amount:1},{eventId:'x',amount:1.5},{eventId:'x',amount:Infinity},{eventId:'x',amount:1000001},{eventId:'x',amount:1,extra:2}])assert.throws(()=>store.apply(event));
    const key="owned'); DROP TABLE inbox; --";store.apply({eventId:key,amount:1});assert.equal(store.apply({eventId:key,amount:1}),false);assert.deepEqual(store.snapshot(),{events:1,total:1});
  }finally{store.close();}
});
