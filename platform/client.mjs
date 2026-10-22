import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const VERSION=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
let core;
export async function loadCore(){if(!core){const artifact=path.join(root,'_build/js/release/build/cmd/bridge/bridge.js');if(!fs.existsSync(artifact))throw new Error('Build first: npm run build');await import(pathToFileURL(artifact));core=globalThis.__moonjet_core;}return core;}
function command(args){const result=JSON.parse(core.command(JSON.stringify(args)));if(!result.ok)throw new Error(result.error);return result.value;}
export function deliveryDecision(delivered,options={}){checkedOptions(options,['maxDeliveries','retryDelayMs','maxRetryDelayMs']);if(!core)throw new Error('Call loadCore before deliveryDecision');return command({action:'delivery',delivered,max_deliveries:options.maxDeliveries===undefined?5:options.maxDeliveries,initial_delay_ms:options.retryDelayMs===undefined?100:options.retryDelayMs,max_delay_ms:options.maxRetryDelayMs===undefined?30000:options.maxRetryDelayMs});}
const encode=(args,payload=Buffer.alloc(0))=>{const bytes=Buffer.from(core.encode(JSON.stringify(args),payload));if(!bytes.length)throw new Error('Protocol encoder rejected unsafe or over-budget request');return bytes;};
const bound=(value,min,max,label)=>{if(!Number.isInteger(value)||value<min||value>max)throw new Error('Invalid '+label+' budget');return value;};
function checkedOptions(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new Error('Invalid options object');for(const key of Reflect.ownKeys(value))if(!allowed.includes(key))throw new Error('Unsupported request option');return value;}
const jsonText=bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes);

export class Message {
  constructor(client,frame){this.client=client;this.generation=client.generation;this.subject=frame.subject;this.reply=frame.reply;this.headers=frame.headers;this.data=Buffer.from(frame.data,'hex');this.metadata=command({action:'metadata',subject:this.reply});this.confirmed=false;this.settled=false;this.settling=false;}
  check(){if(this.settled||this.settling)throw new Error('Delivery already settled or settling');if(this.client.status!=='connected'||this.generation!==this.client.generation)throw new Error('Stale delivery after disconnect; await redelivery');}
  async settle(kind,delayMs=0){this.check();this.settling=true;try{const bytes=Buffer.from(command({action:'ack',kind,delay_ms:delayMs}),'hex');if(kind==='ack')await this.client.request(this.reply,bytes);else await this.client.send(this.reply,bytes);this.settled=true;this.confirmed=kind==='ack';this.client.count?.(kind==='ack'?'acks':kind==='nak'?'naks':'terms');}finally{this.settling=false;}}
  async ack(){if(this.confirmed)return;await this.settle('ack');}
  async nak(delayMs=0){bound(delayMs,0,3600000,'NAK delay');await this.settle('nak',delayMs);}
  async working(){this.check();await this.client.send(this.reply,Buffer.from(command({action:'ack',kind:'working'}),'hex'));this.client.count?.('working');}
  async term(){await this.settle('term');}
}

export class Client extends EventEmitter {
  constructor(url,options={}){
    super();this.endpoint=new URL(url);this.options={timeout:2000,maxReconnects:10,maxPendingBytes:2097152,...options};
    checkedOptions(options,['timeout','maxReconnects','maxPendingBytes','token','user','password','allowPlainAuth','serverName','ca','apiPrefix']);
    for(const key of ['token','user','password'])if(options[key]!==undefined&&(typeof options[key]!=='string'||Buffer.byteLength(options[key])>2048))throw new Error('Invalid credential field');
    if(options.allowPlainAuth!==undefined&&typeof options.allowPlainAuth!=='boolean')throw new Error('allowPlainAuth must be boolean');
    if(options.token&&(options.user||options.password))throw new Error('Choose token or user/password authentication');
    if(!['nats:','tls:'].includes(this.endpoint.protocol)||this.endpoint.username||this.endpoint.password||this.endpoint.search||this.endpoint.hash||!['','/'].includes(this.endpoint.pathname))throw new Error('Use nats:// or tls:// without URL credentials');
    if(this.endpoint.protocol==='nats:'&&(options.token||options.user||options.password)&&!['localhost','127.0.0.1','[::1]'].includes(this.endpoint.hostname)&&!options.allowPlainAuth)throw new Error('Remote plaintext credentials require explicit allowPlainAuth; prefer TLS');
    bound(this.options.timeout,50,30000,'timeout');bound(this.options.maxReconnects,0,20,'reconnect');bound(this.options.maxPendingBytes,1024,16777216,'pending bytes');
    this.id=randomUUID();this.next=0;this.pending=new Map();this.pongs=[];this.status='disconnected';this.closed=false;this.attempts=0;this.timer=null;this.maxPayload=1048576;this.maxReceive=8388608;this.generation=0;
    this.counters={connections:0,reconnects:0,disconnects:0,requests:0,requestFailures:0,peakPending:0,published:0,duplicates:0,deliveries:0,redeliveries:0,acks:0,naks:0,terms:0,working:0,bytesIn:0,bytesOut:0};
  }
  count(key,amount=1){if(Object.hasOwn(this.counters,key))this.counters[key]=Math.min(Number.MAX_SAFE_INTEGER,this.counters[key]+amount);}
  stats(){return Object.freeze({...this.counters,status:this.status,pending:this.pending.size,flushPending:this.pongs.length,bufferedBytes:this.socket?.writableLength||0});}
  static async connect(url='nats://127.0.0.1:4222',options={}){await loadCore();const client=new Client(url,options);try{await client.open();return client;}catch(error){client.close();throw error;}}
  write(bytes){if(!this.socket||this.socket.destroyed)throw new Error('Disconnected; no unbounded outbound queue');if(this.socket.writableLength+bytes.length>this.options.maxPendingBytes)throw new Error('Socket backpressure byte budget exceeded');this.socket.write(bytes);this.count('bytesOut',bytes.length);}
  raw(args,payload){this.write(encode({...args,max_payload:this.maxPayload},payload));}
  async open(){
    if(this.closed)throw new Error('Client closed');if(['connecting','connected'].includes(this.status))throw new Error('Connection already active');this.status='connecting';const generation=++this.generation;command({action:'close',session:this.id});
    return new Promise((resolve,reject)=>{
      const deadline=setTimeout(()=>{reject(new Error('Connection handshake timeout'));this.socket?.destroy();},this.options.timeout);
      let ready=false,authenticated=false,tlsActive=false;
      const fail=error=>{if(generation!==this.generation)return;if(!ready){clearTimeout(deadline);reject(error);}this.socket?.destroy();};
      const connected=()=>{if(authenticated)return;authenticated=true;
        const settings={verbose:false,pedantic:true,lang:'moonbit',version:VERSION,protocol:1,headers:true,no_responders:true};
        if(this.options.token)settings.auth_token=this.options.token;if(this.options.user)settings.user=this.options.user;if(this.options.password)settings.pass=this.options.password;
        this.raw({action:'connect',options:settings});this.pongs.push({resolve:()=>{ready=true;clearTimeout(deadline);this.status='connected';if(this.counters.connections)this.count('reconnects');this.count('connections');this.attempts=0;this.emit('connected');resolve();},reject:fail});this.raw({action:'ping'});
      };
      const data=bytes=>{
        if(this.closed||generation!==this.generation)return;this.count('bytesIn',bytes.length);try{const parsed=JSON.parse(core.decode(JSON.stringify({session:this.id}),bytes));if(!parsed.ok)throw new Error(parsed.error);
          for(const frame of parsed.value){
            if(frame.kind==='INFO'){
              const info=command({action:'response',source:jsonText(Buffer.from(frame.data,'hex'))});
              if(!Number.isSafeInteger(info.max_payload)||info.max_payload<=0)throw new Error('Invalid server max_payload');this.maxPayload=Math.min(info.max_payload,1048576);
              if(!authenticated&&info.headers!==true)throw new Error('Server must support NATS headers for JetStream message IDs');
              if(!authenticated){if(info.nonce&&!this.options.token&&!this.options.user)throw new Error('NKey/JWT authentication not supported');
                if(this.endpoint.protocol==='tls:'&&!tlsActive){const old=this.socket;old.removeListener('data',data);const secure=tls.connect({socket:old,servername:this.options.serverName||this.endpoint.hostname,ca:this.options.ca,rejectUnauthorized:true,minVersion:'TLSv1.2'});this.socket=secure;secure.on('data',data);secure.once('secureConnect',()=>{tlsActive=true;connected();});secure.on('error',fail);secure.once('close',()=>{if(generation===this.generation)this.lost();});}
                else{if(info.tls_required&&!tlsActive)throw new Error('Server requires TLS; use tls:// with trusted CA');connected();}}
            }else if(frame.kind==='PING')this.raw({action:'pong'});
            else if(frame.kind==='PONG'){const pong=this.pongs.shift();if(pong)pong.resolve();}
            else if(frame.kind==='-ERR'){fail(new Error('NATS server rejected protocol or authentication'));}
            else if(frame.kind==='MSG'||frame.kind==='HMSG'){const pending=this.pending.get(frame.sid);if(pending)pending.receive(frame);}
          }
        }catch(error){fail(error);}
      };
      const socket=net.createConnection({host:this.endpoint.hostname.replace(/^\[|\]$/g,''),port:Number(this.endpoint.port||4222)});this.socket=socket;socket.on('data',data);socket.on('error',()=>fail(new Error('NATS transport error')));socket.once('close',()=>{if(!ready){clearTimeout(deadline);reject(new Error('Connection closed before handshake'));}if(generation===this.generation)this.lost();});
    });
  }
  failPending(){const error=new Error('Connection lost; publish outcome may be unknown. Retry only with the same messageId.');for(const p of [...this.pending.values()])p.fail(error);for(const p of this.pongs.splice(0))p.reject(error);}
  lost(){if(this.closed||this.status==='disconnected')return;this.status='disconnected';this.count('disconnects');this.failPending();this.emit('disconnected');this.schedule();}
  schedule(){if(this.closed||this.timer)return;if(this.attempts>=this.options.maxReconnects){this.emit('reconnectExhausted');return;}const delay=command({action:'retry',attempt:this.attempts++});this.timer=setTimeout(async()=>{this.timer=null;try{await this.open();}catch{this.status='disconnected';this.schedule();}},delay);}
  async waitConnected(timeout=10000){bound(timeout,50,60000,'wait');if(this.closed)throw new Error('Client closed');if(this.status==='connected')return;if(this.status==='disconnected'&&this.attempts>=this.options.maxReconnects)throw new Error('Reconnect exhausted');await new Promise((resolve,reject)=>{const cleanup=()=>{clearTimeout(timer);this.removeListener('connected',success);this.removeListener('closed',failure);this.removeListener('reconnectExhausted',failure);};const success=()=>{cleanup();resolve();},failure=()=>{cleanup();reject(new Error('Client closed or reconnect exhausted'));};const timer=setTimeout(()=>{cleanup();reject(new Error('Reconnect wait expired'));},timeout);this.on('connected',success);this.on('closed',failure);this.on('reconnectExhausted',failure);});}
  flush(timeout=this.options.timeout){if(this.status!=='connected')return Promise.reject(new Error('Disconnected'));bound(timeout,50,30000,'flush timeout');if(this.pongs.length>=32)return Promise.reject(new Error('Flush window full'));return new Promise((resolve,reject)=>{const entry={resolve:()=>{clearTimeout(timer);resolve();},reject:error=>{clearTimeout(timer);reject(error);}};const timer=setTimeout(()=>{reject(new Error('Flush timeout; disconnecting to avoid stale PONG correlation'));this.socket?.destroy();},timeout);this.pongs.push(entry);try{this.raw({action:'ping'});}catch(error){entry.reject(error);this.socket?.destroy();}});}
  async send(subject,payload=Buffer.alloc(0),headers=[]){if(this.status!=='connected')throw new Error('Disconnected');if(this.pongs.length>=32)throw new Error('Flush window full');const data=Buffer.from(payload);if(data.length>this.maxPayload)throw new Error('Server payload budget exceeded');this.raw({action:'pub',subject,headers},data);await this.flush();}
  async exchange(subject,payload,options={}){
    checkedOptions(options,['headers','batch','timeout','pull']);const {headers=[],batch=1,timeout=this.options.timeout,pull=false}=options;if(typeof pull!=='boolean')throw new Error('pull must be boolean');if(!Array.isArray(headers))throw new Error('headers must be an array');
    if(this.status!=='connected')return Promise.reject(new Error('Disconnected'));bound(timeout,50,35000,'request timeout');bound(batch,1,256,'batch');if(!pull&&batch!==1)throw new Error('Multiple replies require pull options');const data=Buffer.from(payload);if(data.length>this.maxPayload)return Promise.reject(new Error('Server payload budget exceeded'));
    const sid='r'+(++this.next),reply='_INBOX.MOONJET.'+this.id.replaceAll('-','')+'.'+sid;
    try{command({action:'reserve',session:this.id,key:sid});}catch(error){return Promise.reject(error);}
    return new Promise((resolve,reject)=>{
      const messages=[];let bytes=0,done=false;
      const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);this.pending.delete(sid);command({action:'release',session:this.id,key:sid});if(this.status==='connected'){try{this.raw({action:'unsub',sid});}catch{this.socket?.destroy();}}if(error){this.count('requestFailures');reject(error);}else resolve(pull?messages:messages[0]);};
      const timer=setTimeout(()=>finish(new Error('Request timeout; delivery outcome may be unknown')),timeout);
      this.pending.set(sid,{fail:finish,receive:frame=>{
        if(frame.status===100){if(frame.reply){try{this.raw({action:'pub',subject:frame.reply},Buffer.alloc(0));}catch(error){finish(error);}}return;}
        if(frame.status){if(pull&&[404,408].includes(frame.status))finish();else finish(new Error('NATS response status '+frame.status));return;}
        bytes+=frame.data.length/2;if(bytes>this.maxReceive){finish(new Error('Response payload accumulation budget'));return;}if(pull){const message=new Message(this,frame);this.count('deliveries');if(message.metadata.delivered!=='1')this.count('redeliveries');messages.push(message);}else messages.push(Buffer.from(frame.data,'hex'));if(messages.length>=batch)finish();
      }});
      this.count('requests');this.counters.peakPending=Math.max(this.counters.peakPending,this.pending.size);
      try{this.raw({action:'sub',subject:reply,sid});this.raw({action:'pub',subject,reply,headers},data);}catch(error){finish(error);}
    });
  }
  request(subject,payload=Buffer.alloc(0),options={}){return this.exchange(subject,payload,options);}
  api(operation,stream,consumer='',filter='events.>',options={}){return command({action:'api',operation,stream,consumer,filter,options,prefix:this.options.apiPrefix||'$JS.API'});}
  async manage(operation,stream,consumer='',filter='events.>',options={}){const req=this.api(operation,stream,consumer,filter,options);const data=await this.request(req.subject,Buffer.from(req.body));return command({action:'response',source:jsonText(data)});}
  createStream(name,subject,options={}){return this.manage('stream.create',name,'',subject,options);}
  streamInfo(name){return this.manage('stream.info',name);}
  createConsumer(stream,name,subject,options={}){return this.manage('consumer.create',stream,name,subject,options);}
  consumerInfo(stream,name){return this.manage('consumer.info',stream,name);}
  async publish(subject,payload,options={}){checkedOptions(options,['messageId']);const {messageId}=options;if(typeof messageId!=='string'||!messageId.length||Buffer.byteLength(messageId)>128)throw new Error('Provide stable messageId (1..128 bytes) for safe retry');const data=await this.request(subject,Buffer.from(payload),{headers:[{name:'Nats-Msg-Id',value:messageId}]});const ack=command({action:'publish_ack',source:jsonText(data)});this.count('published');if(ack.duplicate)this.count('duplicates');return {...ack,messageId};}
  async fetch(stream,consumer,options={}){checkedOptions(options,['batch','expiresMs','maxBytes']);const {batch=1,expiresMs=1000,maxBytes=1048576}=options;const req=this.api('consumer.next',stream,consumer,'events.>',{batch,expires_ms:expiresMs,max_bytes:maxBytes});const messages=await this.exchange(req.subject,Buffer.from(req.body),{batch,timeout:expiresMs+500,pull:true});if(messages.some(m=>m.metadata.stream!==stream||m.metadata.consumer!==consumer))throw new Error('Consumer delivery identity mismatch');return messages;}
  async getMessage(stream,sequence){if(typeof sequence!=='string'&&!(typeof sequence==='number'&&Number.isSafeInteger(sequence)&&sequence>0))throw new Error('Use decimal string for 64-bit sequence');const data=await this.manage('message.get',stream,'','events.>',{sequence:String(sequence)});const message=data?.message;if(!message||typeof message.subject!=='string'||String(message.seq)!==String(sequence))throw new Error('Historical response identity mismatch');const encoded=message.data===undefined?'':message.data;if(typeof encoded!=='string'||encoded.length>1398104||!(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)))throw new Error('Invalid historical base64 payload');const payload=Buffer.from(encoded,'base64');if(payload.length>1048576||payload.toString('base64')!==encoded)throw new Error('Invalid historical base64 payload');return {subject:message.subject,sequence:String(message.seq),data:payload};}
  close(){if(this.closed)return;this.closed=true;if(this.timer)clearTimeout(this.timer);this.failPending();this.status='closed';this.socket?.destroy();command({action:'close',session:this.id});this.emit('closed');}
}
