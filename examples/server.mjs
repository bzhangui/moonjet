import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
export function serverBinary(){const suffix=process.platform==='win32'?'.exe':'';const arch=process.arch==='x64'?'amd64':'arm64';const platform=process.platform==='win32'?'windows':process.platform;const candidate=process.env.NATS_SERVER||path.join(root,'.local/tools',`nats-server-v2.15.1-${platform}-${arch}`,'nats-server'+suffix);if(!fs.existsSync(candidate))throw new Error('NATS server missing: node scripts/install-server.mjs or set NATS_SERVER');return candidate;}
export async function startServer({token=null,user=null,password=null,tls=null}={}){
  const account=user!==null||password!==null;
  if(account&&(token!==null||typeof user!=='string'||!user||typeof password!=='string'||!password))throw new Error('Choose a token or a complete synthetic user/password pair');
  const parent=fs.realpathSync(os.tmpdir()),base=fs.mkdtempSync(path.join(parent,'moonjet-test-'));let processHandle,port;
  const config=path.join(base,'server.conf'),storage=path.join(base,'storage');
  async function start(){
    const lines=['host: "127.0.0.1"','port: '+(port??-1),'jetstream { store_dir: '+JSON.stringify(storage)+', max_mem: 16777216, max_file: 67108864 }'];
    if(token)lines.push('authorization { token: '+JSON.stringify(token)+' }');
    if(account)lines.push('authorization { users: [{ user: '+JSON.stringify(user)+', password: '+JSON.stringify(password)+' }] }');
    if(tls)lines.push('tls { cert_file: '+JSON.stringify(tls.cert)+', key_file: '+JSON.stringify(tls.key)+' }');
    fs.writeFileSync(config,lines.join('\n'));processHandle=spawn(serverBinary(),['-c',config],{stdio:['ignore','ignore','pipe'],windowsHide:true});
    await new Promise((resolve,reject)=>{let text='',settled=false;const timer=setTimeout(()=>{if(!settled){settled=true;reject(new Error('Owned NATS server startup timeout'));}},10000);processHandle.once('error',error=>{clearTimeout(timer);reject(error);});processHandle.stderr.on('data',bytes=>{text=(text+bytes.toString('utf8')).slice(-16384);const match=text.match(/Listening for client connections on 127\.0\.0\.1:(\d+)/);if(match&&!settled){settled=true;port=Number(match[1]);clearTimeout(timer);resolve();}});processHandle.once('exit',()=>{if(!settled){settled=true;clearTimeout(timer);reject(new Error('Owned NATS server failed startup'));}});});
    // TCP readiness, without borrowing any existing service.
    await new Promise((resolve,reject)=>{const socket=net.createConnection({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();resolve();});socket.once('error',reject);});
  }
  async function stop(){if(!processHandle||processHandle.exitCode!==null||processHandle.signalCode!==null)return;const gone=once(processHandle,'exit');processHandle.kill();await gone;}
  await start();
  return {get url(){return 'nats://127.0.0.1:'+port;},base,stop,restart:async()=>{await stop();await start();},cleanup:async()=>{await stop();const exact=path.resolve(base);if(path.dirname(exact)!==parent||!path.basename(exact).startsWith('moonjet-test-'))throw new Error('Unsafe test cleanup');fs.rmSync(exact,{recursive:true,force:true});}};
}
