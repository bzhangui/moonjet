import {Client,deliveryDecision,loadCore} from './client.mjs';

export class WorkerError extends Error {
  constructor(code){super('MoonJet worker stopped: '+code);this.name='WorkerError';this.code=code;}
}
const integer=(value,min,max,name)=>{if(!Number.isInteger(value)||value<min||value>max)throw new Error('Invalid worker '+name);return value;};

// One batch at a time: no prefetch queue behind occupied handler slots.
export class PullWorker {
  constructor(client,stream,consumer,handler,options={}){
    if(!(client instanceof Client)||typeof handler!=='function')throw new Error('Client and async handler required');
    const allowed=['concurrency','maxMessages','expiresMs','handlerTimeoutMs','drainTimeoutMs','heartbeatMs','maxDeliveries','retryDelayMs','maxRetryDelayMs','signal'];
    if(!options||typeof options!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(options))||Reflect.ownKeys(options).some(k=>!allowed.includes(k)))throw new Error('Invalid or unsupported worker options');
    this.client=client;this.stream=stream;this.consumer=consumer;this.handler=handler;
    this.options={concurrency:1,maxMessages:1000000,expiresMs:100,handlerTimeoutMs:30000,drainTimeoutMs:5000,maxDeliveries:5,retryDelayMs:100,maxRetryDelayMs:30000,...options};
    for(const [name,min,max] of [['concurrency',1,16],['maxMessages',1,1000000],['expiresMs',50,1000],['handlerTimeoutMs',50,300000],['drainTimeoutMs',50,60000],['maxDeliveries',1,100],['retryDelayMs',1,3600000],['maxRetryDelayMs',1,3600000]])integer(this.options[name],min,max,name);
    if(this.options.retryDelayMs>this.options.maxRetryDelayMs)throw new Error('Invalid worker retry bounds');
    if(options.heartbeatMs!==undefined)integer(options.heartbeatMs,0,60000,'heartbeatMs');
    if(options.signal!==undefined&&!(options.signal instanceof AbortSignal))throw new Error('Invalid worker AbortSignal');
    this.counters={fetched:0,started:0,succeeded:0,handlerFailures:0,retried:0,exhausted:0,timedOut:0,abandoned:0,heartbeats:0,active:0,peakActive:0};
    this.state='idle';this.stopping=false;this.forced=false;this.active=new Set();this.handlers=new Set();this.done=null;this.drainTimer=null;this.failure=null;
  }
  stats(){return Object.freeze({...this.counters,state:this.state,unsettledHandlers:this.handlers.size,quiescent:this.handlers.size===0});}
  async waitForHandlers(timeoutMs=5000){
    integer(timeoutMs,1,60000,'quiescence timeout');let timer;
    try{await Promise.race([Promise.all([...this.handlers]),new Promise(resolve=>{timer=setTimeout(resolve,timeoutMs);})]);return this.handlers.size===0;}
    finally{clearTimeout(timer);}
  }
  run(){
    if(this.done)return this.done;
    this.done=this.loop();return this.done;
  }
  // A stop never closes a shared Client. Deadline expiry fences late ACKs.
  stop(){
    this.stopping=true;
    if(this.state==='running'){
      this.state='draining';
      this.drainTimer=setTimeout(()=>{this.forced=true;this.failure??=new WorkerError('DRAIN_TIMEOUT');for(const controller of this.active)controller.abort(this.failure);},this.options.drainTimeoutMs);
    }
    return this.done||Promise.resolve(this.stats());
  }
  async loop(){
    const signal=this.options.signal;
    const onAbort=()=>{void this.stop();};
    try{
      await loadCore();
      if(this.stopping||signal?.aborted){this.state='stopped';return this.stats();}
      const info=await this.client.consumerInfo(this.stream,this.consumer),config=info.config;
      if(!config||config.ack_policy!=='explicit'||config.deliver_subject||config.durable_name!==this.consumer)throw new WorkerError('INCOMPATIBLE_CONSUMER');
      // Server limits must allow the SDK's retry policy to reach its stop path.
      if(config.max_deliver!==-1&&(!Number.isInteger(config.max_deliver)||config.max_deliver<this.options.maxDeliveries))throw new WorkerError('SERVER_DELIVERY_LIMIT');
      if(config.max_ack_pending!==-1&&(!Number.isInteger(config.max_ack_pending)||config.max_ack_pending<this.options.concurrency))throw new WorkerError('SERVER_PENDING_LIMIT');
      if(config.backoff!==undefined&&(!Array.isArray(config.backoff)||config.backoff.length===0))throw new WorkerError('INVALID_ACK_WAIT');
      const rawAckWait=config.backoff?.[0]??config.ack_wait;
      const ackWait=rawAckWait/1000000;
      if(!Number.isSafeInteger(rawAckWait)||ackWait<60)throw new WorkerError('INVALID_ACK_WAIT');
      this.heartbeatMs=this.options.heartbeatMs??Math.min(1000,Math.max(20,Math.floor(ackWait/3)));
      if(this.heartbeatMs!==0&&(this.heartbeatMs<20||this.heartbeatMs>=ackWait/2))throw new WorkerError('UNSAFE_HEARTBEAT');
      signal?.addEventListener('abort',onAbort,{once:true});
      // stop/abort can happen while the consumer information request is pending.
      if(signal?.aborted)this.stopping=true;
      this.state=this.stopping?'draining':'running';
      while(!this.stopping&&this.counters.started<this.options.maxMessages){
        let messages;
        try{messages=await this.client.fetch(this.stream,this.consumer,{batch:Math.min(this.options.concurrency,this.options.maxMessages-this.counters.started),expiresMs:this.options.expiresMs});}
        catch{throw new WorkerError('PULL_FAILED');}
        this.counters.fetched+=messages.length;
        if(this.stopping){this.counters.abandoned+=messages.length;break;}
        await Promise.all(messages.map(message=>this.process(message)));
        if(this.failure)throw this.failure;
      }
      if(this.failure)throw this.failure;
      this.state='stopped';return this.stats();
    }catch(error){this.stopping=true;this.state='failed';throw error instanceof WorkerError?error:new WorkerError('TRANSPORT_OR_CONFIGURATION');}
    finally{if(this.drainTimer)clearTimeout(this.drainTimer);signal?.removeEventListener('abort',onAbort);}
  }
  async process(message){
    const controller=new AbortController();this.active.add(controller);this.counters.started++;this.counters.active++;this.counters.peakActive=Math.max(this.counters.peakActive,this.counters.active);
    let heartbeatTimer,deadlineTimer,heartbeatPending=null,finished=false;
    const interrupted=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}));
    const stopHeartbeat=async()=>{finished=true;clearInterval(heartbeatTimer);if(heartbeatPending&&!controller.signal.aborted)await heartbeatPending;};
    try{
      deadlineTimer=setTimeout(()=>{this.counters.timedOut++;controller.abort(new WorkerError('HANDLER_TIMEOUT'));},this.options.handlerTimeoutMs);
      if(this.heartbeatMs)heartbeatTimer=setInterval(()=>{
        if(finished||heartbeatPending)return;
        heartbeatPending=message.working().then(()=>{this.counters.heartbeats++;},()=>{controller.abort(new WorkerError('HEARTBEAT_FAILED'));}).finally(()=>{heartbeatPending=null;});
      },this.heartbeatMs);
      // No ACK methods in the handler context; settlement belongs to the worker.
      const context=Object.freeze({subject:message.subject,data:message.data,headers:Object.freeze(message.headers.map(h=>Object.freeze({...h}))),metadata:Object.freeze({...message.metadata}),signal:controller.signal});
      let handlerFailed=false;
      const task=Promise.resolve().then(()=>this.handler(context)).catch(()=>{handlerFailed=true;}).finally(()=>this.handlers.delete(task));
      this.handlers.add(task);
      await Promise.race([task,interrupted]);
      clearTimeout(deadlineTimer);await stopHeartbeat();
      if(controller.signal.aborted)throw controller.signal.reason;
      if(this.forced)throw new WorkerError('DRAIN_TIMEOUT');
      if(handlerFailed){
        this.counters.handlerFailures++;
        const decision=deliveryDecision(message.metadata.delivered,{maxDeliveries:this.options.maxDeliveries,retryDelayMs:this.options.retryDelayMs,maxRetryDelayMs:this.options.maxRetryDelayMs});
        if(decision.action==='stop'){this.counters.exhausted++;throw new WorkerError('DELIVERY_LIMIT');}
        await message.nak(decision.delay_ms);this.counters.retried++;
      }else{await message.ack();this.counters.succeeded++;}
    }catch(error){
      this.counters.abandoned++;this.stopping=true;this.failure??=error instanceof WorkerError?error:new WorkerError('SETTLEMENT_FAILED');
      for(const active of this.active)if(active!==controller)active.abort(this.failure);
    }finally{
      clearTimeout(deadlineTimer);await stopHeartbeat();this.active.delete(controller);this.counters.active--;
    }
  }
}
