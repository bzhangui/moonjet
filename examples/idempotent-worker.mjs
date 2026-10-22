import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Client} from '../platform/client.mjs';
import {PullWorker} from '../platform/worker.mjs';
import {InboxStore} from './inbox-store.mjs';
import {startServer} from './server.mjs';

const server=await startServer();let client,store;
try{
  client=await Client.connect(server.url);
  await client.createStream('ORDERS','orders.>');
  await client.createConsumer('ORDERS','ACCOUNTING','orders.>',{ack_wait_ms:100});
  const file=path.join(server.base,'example-inbox.sqlite');store=new InboxStore(file);
  const event={eventId:'synthetic-order-paid-42',amount:125};
  await client.publish('orders.paid',Buffer.from(JSON.stringify(event)),{messageId:'transport-1'});
  const [delivery]=await client.fetch('ORDERS','ACCOUNTING');
  assert.equal(store.apply(JSON.parse(delivery.data.toString())),true);
  // Controlled post-commit/pre-ACK interruption; SQLite is then reopened.
  client.close();store.close();store=new InboxStore(file);
  client=await Client.connect(server.url);
  // A second transport ID for the same business event bypasses server dedup.
  await client.publish('orders.paid',Buffer.from(JSON.stringify(event)),{messageId:'transport-2'});
  let skipped=0;
  const worker=new PullWorker(client,'ORDERS','ACCOUNTING',async({data})=>{
    if(!store.apply(JSON.parse(data.toString())))skipped++;
  },{maxMessages:2});
  const report=await worker.run();
  assert.deepEqual(store.snapshot(),{events:1,total:125});assert.equal(skipped,2);assert.equal(report.succeeded,2);
  // Transaction rollback includes BOTH the inbox row and business effect.
  assert.throws(()=>store.apply({eventId:'synthetic-rollback',amount:50},{failBeforeCommit:true}));
  assert.deepEqual(store.snapshot(),{events:1,total:125});
  console.log(JSON.stringify({ok:true,owned_local_broker:true,synthetic_data:true,real_user_pilot:false,sqlite_transaction:true,post_commit_pre_ack_replay:true,duplicate_business_events_skipped:skipped,rollback_verified:true,stats:worker.stats(),client:client.stats()}));
}finally{client?.close();store?.close();await server.cleanup();}
