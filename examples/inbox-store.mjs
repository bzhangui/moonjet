// Example only: business update and inbox key share ONE local SQLite transaction.
// This does not make HTTP/email/another database atomic with this transaction.
import {DatabaseSync} from 'node:sqlite';

export class InboxStore {
  constructor(filename){
    this.db=new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS inbox (event_id TEXT PRIMARY KEY, amount INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS totals (id INTEGER PRIMARY KEY CHECK(id=1), amount INTEGER NOT NULL); INSERT OR IGNORE INTO totals VALUES (1,0);');
  }
  apply(event,{failBeforeCommit=false}={}){
    if(!event||Object.getPrototypeOf(event)!==Object.prototype||Object.keys(event).sort().join(',')!=='amount,eventId'||typeof event.eventId!=='string'||!event.eventId.length||Buffer.byteLength(event.eventId)>128||!Number.isSafeInteger(event.amount)||Math.abs(event.amount)>1000000)throw new Error('Invalid example business event');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const existing=this.db.prepare('SELECT amount FROM inbox WHERE event_id=?').get(event.eventId);
      if(existing){if(existing.amount!==event.amount)throw new Error('Business idempotency key conflict');this.db.exec('ROLLBACK');return false;}
      const total=this.db.prepare('SELECT amount FROM totals WHERE id=1').get().amount;
      if(!Number.isSafeInteger(total+event.amount))throw new Error('Example total exceeds safe integer budget');
      this.db.prepare('INSERT INTO inbox(event_id,amount) VALUES (?,?)').run(event.eventId,event.amount);
      this.db.prepare('UPDATE totals SET amount=? WHERE id=1').run(total+event.amount);
      if(failBeforeCommit)throw new Error('Controlled failure before commit');
      this.db.exec('COMMIT');return true;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  snapshot(){return {events:this.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n,total:this.db.prepare('SELECT amount FROM totals WHERE id=1').get().amount};}
  close(){if(this.closed)return;this.db.close();this.closed=true;}
}
