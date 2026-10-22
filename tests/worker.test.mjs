import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {Client,deliveryDecision,loadCore} from '../platform/client.mjs';
import {PullWorker} from '../platform/worker.mjs';
import {startServer} from '../examples/server.mjs';

async function fixture(fn,consumer={}){
  const server=await startServer();let client;
  try{client=await Client.connect(server.url);await client.createStream('JOBS','jobs.>');await client.createConsumer('JOBS','WORKER','jobs.>',consumer);await fn(client,server);}
  finally{client?.close();await server.cleanup();}
}
const publish=(c,n=1)=>Promise.all(Array.from({length:n},(_,i)=>c.publish('jobs.work',Buffer.from('private-payload-'+i),{messageId:'private-id-'+i})));
const ready=async predicate=>{for(let i=0;i<400;i++){if(predicate())return;await delay(10);}throw new Error('Test condition timeout');};

test('worker bounds concurrency, confirms only successful handlers and exposes redacted snapshots',()=>fixture(async c=>{
  await publish(c,8);let active=0,peak=0;
  const worker=new PullWorker(c,'JOBS','WORKER',async context=>{assert.equal(context.ack,undefined);assert.ok(Object.isFrozen(context.metadata));active++;peak=Math.max(peak,active);await delay(10);active--;},{concurrency:3,maxMessages:8});
  const result=await worker.run();assert.equal(result.succeeded,8);assert.equal(result.peakActive,3);assert.equal(peak,3);assert.equal(result.active,0);
  const stats=c.stats();assert.equal(stats.published,8);assert.equal(stats.acks,8);assert.equal(stats.pending,0);assert.ok(Object.isFrozen(stats));
  assert.ok(!/private-payload|private-id|127\.0|token|password|subject/i.test(JSON.stringify(stats)));
  assert.equal((await c.consumerInfo('JOBS','WORKER')).num_ack_pending,0);
}));
test('worker failure delays retry through MoonBit policy and eventually confirms',()=>fixture(async c=>{
  await publish(c);let calls=0;
  const worker=new PullWorker(c,'JOBS','WORKER',async()=>{if(++calls<3)throw new Error('private downstream detail');},{maxMessages:3,retryDelayMs:25,maxRetryDelayMs:50});
  const result=await worker.run();assert.equal(result.retried,2);assert.equal(result.succeeded,1);assert.equal(result.handlerFailures,2);assert.equal(c.stats().redeliveries,2);
}));
test('poison delivery stops without ACK or TERM and remains available for explicit replay',()=>fixture(async c=>{
  await publish(c);const worker=new PullWorker(c,'JOBS','WORKER',async()=>{throw new Error('private-error');},{maxDeliveries:2,retryDelayMs:10,maxRetryDelayMs:20});
  await assert.rejects(worker.run(),error=>error.code==='DELIVERY_LIMIT'&&!error.message.includes('private-error'));
  assert.equal(worker.stats().exhausted,1);assert.equal(c.stats().acks,0);assert.equal(c.stats().terms,0);
  assert.equal((await c.getMessage('JOBS','1')).data.toString(),'private-payload-0');
  await c.createConsumer('JOBS','INSPECT','jobs.>',{start_sequence:'1'});const [m]=await c.fetch('JOBS','INSPECT');await m.ack();
}));
test('automatic working keeps a slow handler alive beyond initial ACK wait',()=>fixture(async c=>{
  await publish(c);const worker=new PullWorker(c,'JOBS','WORKER',async()=>delay(450),{maxMessages:1});
  const result=await worker.run();assert.ok(result.heartbeats>=2);assert.equal(c.stats().redeliveries,0);assert.equal(result.succeeded,1);
  assert.equal((await c.consumerInfo('JOBS','WORKER')).num_ack_pending,0);
},{ack_wait_ms:150}));
test('handler timeout fences late completion, aborts context and does not ACK or NAK',()=>fixture(async c=>{
  await publish(c);let aborted=false,finished=false;
  const worker=new PullWorker(c,'JOBS','WORKER',async({signal})=>{signal.addEventListener('abort',()=>{aborted=true;},{once:true});await delay(160);finished=true;},{handlerTimeoutMs:50,maxMessages:1});
  await assert.rejects(worker.run(),e=>e.code==='HANDLER_TIMEOUT');await delay(180);assert.ok(aborted&&finished);assert.equal(c.stats().acks,0);assert.equal(c.stats().naks,0);assert.equal(worker.stats().timedOut,1);
}));
test('graceful stop finishes active work, prevents new pulls and keeps shared client open',()=>fixture(async c=>{
  await publish(c,4);let started=false;const worker=new PullWorker(c,'JOBS','WORKER',async()=>{started=true;await delay(100);});
  const done=worker.run();await ready(()=>started);await worker.stop();await done;
  assert.equal(worker.stats().succeeded,1);assert.equal(c.status,'connected');assert.equal((await c.streamInfo('JOBS')).state.messages,4);
}));
test('drain deadline fences uncooperative handler and suppresses a late ACK',()=>fixture(async c=>{
  await publish(c);let started=false;
  const worker=new PullWorker(c,'JOBS','WORKER',async()=>{started=true;await delay(200);},{drainTimeoutMs:50});
  const done=worker.run();const rejected=assert.rejects(done,e=>e.code==='DRAIN_TIMEOUT');await ready(()=>started);await assert.rejects(worker.stop(),e=>e.code==='DRAIN_TIMEOUT');await rejected;await delay(220);
  assert.equal(c.stats().acks,0);assert.equal(worker.stats().active,0);
}));
test('already aborted worker never queries the server and repeated run returns the same promise',()=>fixture(async c=>{
  const controller=new AbortController();controller.abort();const before=c.stats().requests;
  const worker=new PullWorker(c,'JOBS','WORKER',()=>assert.fail('handler must not run'),{signal:controller.signal});const first=worker.run();assert.equal(worker.run(),first);assert.equal((await first).state,'stopped');assert.equal(c.stats().requests,before);
}));
test('AbortSignal gracefully stops idle fetching without leaked reservations',()=>fixture(async c=>{
  const controller=new AbortController();const worker=new PullWorker(c,'JOBS','WORKER',()=>assert.fail('empty stream'),{signal:controller.signal});
  const done=worker.run();await ready(()=>worker.state==='running');controller.abort();assert.equal((await done).state,'stopped');assert.equal(c.pending.size,0);
}));
test('worker preflights retry and heartbeat compatibility before handling data',()=>fixture(async c=>{
    for(const [options,code] of [[{maxDeliveries:6},'SERVER_DELIVERY_LIMIT'],[{heartbeatMs:20000},'UNSAFE_HEARTBEAT']]){
    await assert.rejects(new PullWorker(c,'JOBS','WORKER',()=>assert.fail('must not run'),options).run(),e=>e.code===code);
  }
  await assert.rejects(new PullWorker(c,'JOBS','WORKER',()=>{}, {concurrency:2}).run(),e=>e.code==='SERVER_PENDING_LIMIT');
},{max_ack_pending:1}));
test('connection loss never acknowledges a stale generation and worker stops with unknown outcome',()=>fixture(async(c,server)=>{
  await publish(c);let started=false,finish;const gate=new Promise(resolve=>{finish=resolve;});
  const worker=new PullWorker(c,'JOBS','WORKER',async()=>{started=true;await gate;},{maxMessages:1,heartbeatMs:0});
  const done=worker.run();const rejected=assert.rejects(done,e=>e.code==='SETTLEMENT_FAILED');await ready(()=>started);await server.restart();await c.waitConnected();finish();await rejected;
  assert.equal(c.stats().acks,0);assert.ok(c.stats().reconnects>=1);assert.equal(worker.stats().abandoned,1);
}));
test('final delivery actions are fenced against double settlement and reconnect',()=>fixture(async(c,server)=>{
  await publish(c);const [first]=await c.fetch('JOBS','WORKER');await first.nak(10);await assert.rejects(first.ack(),/settled/);await assert.rejects(first.working(),/settled/);
  const [again]=await c.fetch('JOBS','WORKER');await server.restart();await c.waitConnected();await assert.rejects(again.ack(),/Stale/);await assert.rejects(again.term(),/Stale/);
}));
test('worker rejects malformed, unbounded, null and unknown options before network',async()=>{
  await loadCore();const c=new Client('nats://127.0.0.1:1');
  try{
    for(const options of [null,[],{concurrency:17},{concurrency:null},{maxMessages:Infinity},{handlerTimeoutMs:1},{heartbeatMs:-1},{signal:{}},{retryDelayMs:200,maxRetryDelayMs:100},{unknown:true}])assert.throws(()=>new PullWorker(c,'JOBS','WORKER',()=>{},options));
    for(const options of [{maxDeliveries:null},{retryDelayMs:0},{maxDeliveries:101},{maxRetryDelayMs:NaN},{[Symbol('ignored')]:1}])assert.throws(()=>deliveryDecision('1',options));
    for(const count of ['0','01','18446744073709551616'])assert.throws(()=>deliveryDecision(count));
    assert.deepEqual(deliveryDecision('18446744073709551615'),{action:'stop',delay_ms:0});
  }finally{c.close();}
});

test('one exhausted handler aborts its batch peers and reports nonquiescent work honestly',()=>fixture(async c=>{
  await publish(c,2);let release;const gate=new Promise(resolve=>{release=resolve;});let entered=false;
  const worker=new PullWorker(c,'JOBS','WORKER',async({data})=>{if(data.toString().endsWith('0')){await ready(()=>entered);throw new Error('controlled');}entered=true;await gate;},{concurrency:2,maxDeliveries:1});
  await assert.rejects(worker.run(),e=>e.code==='DELIVERY_LIMIT');assert.equal(worker.stats().quiescent,false);assert.equal(worker.stats().unsettledHandlers,1);assert.equal(await worker.waitForHandlers(5),false);
  release();assert.equal(await worker.waitForHandlers(1000),true);assert.equal(c.stats().acks,0);assert.equal(worker.stats().abandoned,2);
}));
test('duplicate publish and failed requests are visible without exposing identifiers',()=>fixture(async c=>{
  await publish(c);await c.publish('jobs.work',Buffer.from('other-private-data'),{messageId:'private-id-0'});await assert.rejects(c.request('absent.service'));
  const stats=c.stats();assert.equal(stats.duplicates,1);assert.equal(stats.published,2);assert.equal(stats.requestFailures,1);assert.equal(stats.pending,0);
  assert.ok(!JSON.stringify(stats).includes('private'));assert.throws(()=>{stats.requests=-1;});
}));
test('worker rejects incomplete consumer configuration and stops before dispatch',()=>fixture(async c=>{
  const info=await c.consumerInfo('JOBS','WORKER');
  for(const [patch,code] of [[{ack_policy:'all'},'INCOMPATIBLE_CONSUMER'],[{max_ack_pending:null},'SERVER_PENDING_LIMIT'],[{ack_wait:'30000000000'},'INVALID_ACK_WAIT'],[{backoff:[]},'INVALID_ACK_WAIT']]){
    c.consumerInfo=async()=>({...info,config:{...info.config,...patch}});
    await assert.rejects(new PullWorker(c,'JOBS','WORKER',()=>assert.fail('must not dispatch')).run(),e=>e.code===code);
  }
}));
test('byte-limited partial batches retain delivered messages and worker continues through large payloads',()=>fixture(async c=>{
  for(let i=0;i<3;i++)await c.publish('jobs.large',Buffer.alloc(600000,i),{messageId:'owned-large-'+i});
  const first=await c.fetch('JOBS','WORKER',{batch:3,expiresMs:100});assert.equal(first.length,1);await first[0].ack();
  const worker=new PullWorker(c,'JOBS','WORKER',async({data})=>{assert.equal(data.length,600000);},{concurrency:2,maxMessages:2});
  assert.equal((await worker.run()).succeeded,2);assert.equal(c.stats().acks,3);assert.equal(c.pending.size,0);
  await c.createConsumer('JOBS','TINY','jobs.>');await assert.rejects(c.fetch('JOBS','TINY',{maxBytes:100}),/409/);assert.equal(c.pending.size,0);
}));
test('partial batch wait is capped below ACK wait before any handler dispatch',()=>fixture(async c=>{
  await publish(c);const worker=new PullWorker(c,'JOBS','WORKER',async()=>{}, {concurrency:4,maxMessages:4,expiresMs:1000});
  const done=worker.run();await ready(()=>worker.stats().succeeded===1);await worker.stop();await done;
  assert.equal(worker.stats().effectiveExpiresMs,40);assert.equal(c.stats().redeliveries,0);assert.equal(c.stats().acks,1);
},{ack_wait_ms:120}));
