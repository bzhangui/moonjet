// Reference-only fixture. The MoonJet runtime does not call nats.go or jwt.
package main

import (
  "bytes"
  "context"
  "encoding/json"
  "fmt"
  "os"
  "time"
  "github.com/nats-io/nats.go"
  "github.com/nats-io/nats.go/jetstream"
  jwt "github.com/nats-io/jwt/v2"
  "github.com/nats-io/nkeys"
)
func must(err error) {if err!=nil {panic(err)}}
func main(){
  if len(os.Args)<2 {panic("fixture mode required")}
  if os.Args[1]=="auth" {auth();return}
  if len(os.Args)!=7 {panic("mode URL stream KV OS subject required")}
  nc,err:=nats.Connect(os.Args[2],nats.Timeout(5*time.Second),nats.NoReconnect());must(err);defer nc.Close()
  js,err:=jetstream.New(nc);must(err)
  ctx,cancel:=context.WithTimeout(context.Background(),10*time.Second);defer cancel()
  kv,err:=js.KeyValue(ctx,os.Args[4]);must(err);obj,err:=js.ObjectStore(ctx,os.Args[5]);must(err)
  payload:=[]byte{0,255,13,10,71,79}
  if os.Args[1]=="produce" {
    _,err=js.Publish(ctx,os.Args[6],payload);must(err)
    _,err=kv.Put(ctx,"go.key",payload);must(err)
    _,err=obj.PutBytes(ctx,"go.bin",bytes.Repeat(payload,50000));must(err)
    fmt.Println(`{"go_produced":true}`);return
  }
  stream,err:=js.Stream(ctx,os.Args[3]);must(err)
  message,err:=stream.GetLastMsgForSubject(ctx,os.Args[6]);must(err)
  if !bytes.Equal(message.Data,payload){panic("message bytes differ")}
  entry,err:=kv.Get(ctx,"moon.key");must(err);if !bytes.Equal(entry.Value(),payload){panic("KV bytes differ")}
  found,err:=obj.GetBytes(ctx,"moon.bin");must(err);if !bytes.Equal(found,bytes.Repeat(payload,50000)){panic("object bytes differ")}
  fmt.Println(`{"go_consumed":true}`)
}
func auth(){
  op,err:=nkeys.CreateOperator();must(err);opPub,err:=op.PublicKey();must(err)
  ac,err:=nkeys.CreateAccount();must(err);acPub,err:=ac.PublicKey();must(err)
  sys,err:=nkeys.CreateAccount();must(err);sysPub,err:=sys.PublicKey();must(err)
  oc:=jwt.NewOperatorClaims(opPub);oc.SystemAccount=sysPub;operator,err:=oc.Encode(op);must(err)
  sysClaims:=jwt.NewAccountClaims(sysPub);sysJWT,err:=sysClaims.Encode(op);must(err)
  account:=jwt.NewAccountClaims(acPub)
  account.Limits.JetStreamLimits.DiskStorage=67108864
  account.Limits.JetStreamLimits.MemoryStorage=16777216
  account.Limits.JetStreamLimits.Streams=32
  account.Limits.JetStreamLimits.Consumer=128
  accountJWT,err:=account.Encode(op);must(err)
  result:=map[string]string{"operator":operator,"account":acPub,"accountJWT":accountJWT,"system":sysPub,"systemJWT":sysJWT}
  for _,kind:=range []string{"first","second","expired"} {
    user,err:=nkeys.CreateUser();must(err);pub,err:=user.PublicKey();must(err)
    claims:=jwt.NewUserClaims(pub);if kind=="expired" {claims.Expires=time.Now().Add(-time.Minute).Unix()}
    token,err:=claims.Encode(ac);must(err);seed,err:=user.Seed();must(err)
    result[kind+"JWT"]=token;result[kind+"Seed"]=string(seed)
  }
  // Captured in memory by the test runner; never printed to public CI logs.
  must(json.NewEncoder(os.Stdout).Encode(result))
}
