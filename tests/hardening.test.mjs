import test from 'node:test';
import assert from 'node:assert/strict';
import {Client,Message,loadCore} from '../platform/client.mjs';
import {startServer} from '../examples/server.mjs';
const core=await loadCore();
test('invalid NAK delay never becomes immediate wire redelivery',async()=>{
  let writes=0;const message=new Message({send:async()=>{writes++;}},{subject:'events.a',reply:'$JS.ACK.TEST.WORKER.1.1.1.123456789.0',headers:[],data:'78'});
  for(const delay of [NaN,null,'100',1.5,-1,3600001])await assert.rejects(message.nak(delay));
  for(const delay_ms of [null,'100'])assert.equal(JSON.parse(core.command(JSON.stringify({action:'ack',kind:'nak',delay_ms}))).ok,false);
  assert.equal(writes,0);
});
test('protocol rejects embedded controls early header terminators and invalid status',()=>{
  for(const header of ['NATS/1.0\r\nX: bad\u0000value\r\n\r\n','NATS/1.0\r\n\r\nX: injected\r\n\r\n','NATS/1.0 000 Invalid\r\n\r\n']){
    const bytes=Buffer.from(header),wire=Buffer.concat([Buffer.from('HMSG inbox 1 '+bytes.length+' '+bytes.length+'\r\n'),bytes,Buffer.from('\r\n')]),session='hardening-'+Math.random();
    try{assert.equal(JSON.parse(core.decode(JSON.stringify({session}),wire)).ok,false);}finally{core.command(JSON.stringify({action:'close',session}));}
  }
});
test('username-only remote credentials and ignored request options are rejected',async()=>{
  assert.throws(()=>new Client('nats://example.invalid:4222',{user:'controlled-only'}),/plaintext|TLS/);
  const c=new Client('nats://127.0.0.1:1');c.status='connected';c.raw=()=>{throw new Error('No network should occur');};
  try{await assert.rejects(c.request('service',Buffer.from('x'),{pull:'false'}),/boolean|option/);await assert.rejects(c.request('service',Buffer.from('x'),{timeouts:10}),/option/);}finally{c.close();}
});
test('historical message retrieval round-trips the supported near-limit binary payload',async()=>{
  const server=await startServer();let c;
  try{c=await Client.connect(server.url);await c.createStream('LARGE','events.>');const payload=Buffer.alloc(900000,173);const ack=await c.publish('events.large',payload,{messageId:'controlled-large'});const restored=await c.getMessage('LARGE',ack.sequence);assert.deepEqual(restored.data,payload);}finally{c?.close();await server.cleanup();}
});
test('malformed historical base64 cannot be silently returned as empty payload',async()=>{
  const c=new Client('nats://127.0.0.1:1');c.manage=async()=>({message:{subject:'events.a',seq:'1',data:'????'}});
  try{await assert.rejects(c.getMessage('TEST','1'),/base64/);}finally{c.close();}
});
test('connection options reject prototype and symbol keys instead of ignoring safety settings',()=>{
  for(const options of [null,[],Object.create({rejectUnauthorized:false}),{[Symbol('security')]:false}])assert.throws(()=>new Client('nats://127.0.0.1:1',options));
});
test('pull rejects a response belonging to another stream before exposing delivery',async()=>{
  const c=new Client('nats://127.0.0.1:1');c.exchange=async()=>[{metadata:{stream:'OTHER',consumer:'WORKER'}}];
  try{await assert.rejects(c.fetch('TEST','WORKER'),/identity mismatch/);}finally{c.close();}
});
