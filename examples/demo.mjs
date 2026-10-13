import assert from 'node:assert/strict';
import {Client} from '../platform/client.mjs';
import {startServer} from './server.mjs';
const server=await startServer();let client;
try{
  client=await Client.connect(server.url);
  await client.createStream('EVENTS','events.>');await client.createConsumer('EVENTS','WORKER','events.>',{ack_wait_ms:200,max_ack_pending:2});
  const first=await client.publish('events.order',Buffer.from('first'),{messageId:'order-1'});const duplicate=await client.publish('events.order',Buffer.from('first'),{messageId:'order-1'});assert.equal(first.sequence,duplicate.sequence);assert.equal(duplicate.duplicate,true);
  const [message]=await client.fetch('EVENTS','WORKER');assert.equal(message.data.toString(),'first');await message.nak(100);const [again]=await client.fetch('EVENTS','WORKER');assert.equal(again.metadata.stream_sequence,first.sequence);assert.ok(Number(again.metadata.delivered)>=2);await again.ack();assert.equal(again.confirmed,true);
  const secondAck=await client.publish('events.order',Buffer.from('second'),{messageId:'order-2'});
  await server.restart();await client.waitConnected();const info=await client.streamInfo('EVENTS');assert.equal(info.state.messages,2);
  // Abrupt single-node restart can redeliver even previously confirmed work.
  // Demonstrate business idempotency rather than pretending ACK is a disk fsync.
  const processed=new Set([first.sequence]);let secondSeen=false,redeliveredAfterRestart=false;
  for(let attempt=0;attempt<6&&!secondSeen;attempt++){
    const recovered=await client.fetch('EVENTS','WORKER');
    for(const message of recovered){const seq=message.metadata.stream_sequence;if(processed.has(seq))redeliveredAfterRestart=true;else processed.add(seq);if(seq===secondAck.sequence){assert.equal(message.data.toString(),'second');secondSeen=true;}await message.ack();}
  }
  assert.ok(secondSeen);
  await client.createConsumer('EVENTS','REPLAY','events.>',{start_sequence:first.sequence});const replay=await client.fetch('EVENTS','REPLAY',{batch:2});assert.deepEqual(replay.map(m=>m.data.toString()),['first','second']);for(const m of replay)await m.ack();
  console.log(JSON.stringify({ok:true,owned_local_broker:true,broker_version:'2.15.1',real_user_pilot:false,scenarios:['publish-dedup-confirmed-ack','nak-redelivery','persistent-restart-and-historical-replay'],redelivered_after_abrupt_restart:redeliveredAfterRestart,messages:info.state.messages}));
}finally{client?.close();await server.cleanup();}
