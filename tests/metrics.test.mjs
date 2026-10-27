import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {Client} from '../platform/client.mjs';
import {startServer} from '../examples/server.mjs';

function failures(client,expected){
  const stats=client.stats();
  for(const [key,value] of Object.entries(expected))assert.equal(stats[key],value,key);
  assert.equal(stats.requestFailures,stats.exchangeFailures+stats.apiErrors+stats.responseFailures);
  assert.equal(stats.pending,0);assert.ok(Object.isFrozen(stats));
  assert.ok(!/private-detail|controlled-password|event-secret/.test(JSON.stringify(stats)));
}

async function withReply(bytes,fn){
  const sockets=new Set();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
    socket.write('INFO {"max_payload":1048576,"headers":true,"proto":1}\r\n');
    let input='';const subscriptions=new Map();
    socket.on('data',chunk=>{
      input+=chunk.toString();
      while(input.includes('\r\n')){
        const end=input.indexOf('\r\n'),line=input.slice(0,end);input=input.slice(end+2);
        const parts=line.split(' ');
        if(line==='PING')socket.write('PONG\r\n');
        else if(parts[0]==='SUB')subscriptions.set(parts[1],parts[2]);
        else if(bytes!==null&&['PUB','HPUB'].includes(parts[0])&&subscriptions.has(parts[2])){
          const reply=parts[2],sid=subscriptions.get(reply);
          socket.write(Buffer.concat([Buffer.from('MSG '+reply+' '+sid+' '+bytes.length+'\r\n'),bytes,Buffer.from('\r\n')]));
        }
      }
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let client;
  try{client=await Client.connect('nats://127.0.0.1:'+server.address().port,{maxReconnects:0});await fn(client);}
  finally{client?.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
}

test('missing stream, consumer and stored message count API errors exactly once and recover',async()=>{
  const server=await startServer();let c;
  try{
    c=await Client.connect(server.url);await c.createStream('TEST','events.>');
    for(const operation of [()=>c.streamInfo('MISSING'),()=>c.consumerInfo('TEST','MISSING'),()=>c.getMessage('TEST','1')])await assert.rejects(operation(),/JetStream API error/);
    failures(c,{requestFailures:3,apiErrors:3,responseFailures:0,exchangeFailures:0});
    assert.equal((await c.streamInfo('TEST')).config.name,'TEST');
    failures(c,{requests:5,requestFailures:3,apiErrors:3});
    const before=c.stats().requests;await assert.rejects(c.fetch('TEST','BAD',{batch:257}));
    failures(c,{requests:before,requestFailures:3});
    await assert.rejects(c.request('absent.service'),/503/);
    failures(c,{requestFailures:4,apiErrors:3,exchangeFailures:1});
  }finally{c?.close();await server.cleanup();}
});

test('invalid UTF-8, malformed JSON and non-object replies count response failures once',async()=>{
  for(const bytes of [Buffer.from([255]),Buffer.from('{'),Buffer.from('[]')])await withReply(bytes,async c=>{
    await assert.rejects(c.streamInfo('TEST'));
    failures(c,{requests:1,requestFailures:1,responseFailures:1,apiErrors:0,exchangeFailures:0});
  });
});

test('publish API errors and malformed PubAck are distinct and never count as successful publish',async()=>{
  await withReply(Buffer.from('{"error":{"code":500,"err_code":10000,"description":"private-detail"}}'),async c=>{
    await assert.rejects(c.publish('events.a',Buffer.from('event-secret'),{messageId:'event-secret'}),error=>/JetStream API error/.test(error.message)&&!error.message.includes('private-detail'));
    failures(c,{requests:1,published:0,requestFailures:1,apiErrors:1,responseFailures:0});
  });
  await withReply(Buffer.from('{"stream":"TEST","seq":0}'),async c=>{
    await assert.rejects(c.publish('events.a',Buffer.from('event-secret'),{messageId:'event-secret'}));
    failures(c,{published:0,requestFailures:1,apiErrors:0,responseFailures:1});
  });
});

test('historical identity and Base64 validation failures remain visible after JSON decode',async()=>{
  for(const message of [{subject:'events.a',seq:2,data:'eA=='},{subject:'events.a',seq:1,data:'????'}])await withReply(Buffer.from(JSON.stringify({message})),async c=>{
    await assert.rejects(c.getMessage('TEST','1'),/identity|base64/);
    failures(c,{requests:1,requestFailures:1,responseFailures:1,apiErrors:0,exchangeFailures:0});
  });
});

test('request timeout through management counts exchange failure without response double counting',()=>withReply(null,async c=>{
    c.options.timeout=50;
    await assert.rejects(c.streamInfo('TEST'),/timeout/);
    failures(c,{requests:1,requestFailures:1,exchangeFailures:1,apiErrors:0,responseFailures:0});
}));
