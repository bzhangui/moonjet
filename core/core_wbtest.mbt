///|
test "fragmented binary MSG and multiple controls" {
  let decoder = Decoder::new()
  assert_true(decoder.feed(b"MSG events 1 reply 4\r\n\x00").is_empty())
  let frames = decoder.feed(b"\xff\r\n\r\nPING\r\nPONG\r\n")
  assert_true(frames.length() == 3)
  assert_true(frames[0].payload == b"\x00\xff\r\n")
  assert_true(frames[0].reply == "reply")
  assert_true(frames[1].kind == "PING")
  decoder.finish()
}

///|
test "HPUB uses UTF8 byte lengths and blocks injection" {
  let encoded = publish("events",b"body",reply="inbox",headers=[{name:"Nats-Msg-Id",value:"unique"}])
  assert_true(@utf8.decode(encoded).has_prefix("HPUB events inbox "))
  let failure = try { ignore(publish("events\r\nPING",b"bad")); false } catch { _ => true }
  assert_true(failure)
  assert_true(@utf8.decode(subscribe("events.*","1")) == "SUB events.* 1\r\n")
}

///|
test "header status and empty message" {
  let decoder = Decoder::new()
  let headers = b"NATS/1.0 503 No Responders\r\n\r\n"
  let source = @utf8.encode("HMSG inbox 1 \{headers.length()} \{headers.length()}\r\n")+headers+b"\r\n"
  let frames = decoder.feed(source)
  assert_true(frames.length() == 1 && frames[0].status == 503)
  assert_true(frames[0].payload.is_empty())
}

///|
test "JetStream nanosecond durations are JSON numbers not Int64 strings" {
  let stream=api_request("stream.create","EVENTS",filter="events.>")
  let stream_body=parse_json(stream.body)
  assert_true(json_field(stream_body,"duplicate_window") is Number(_,..))
  let consumer=api_request("consumer.create","EVENTS",consumer="WORKER",filter="events.>",options={"ack_wait_ms":200})
  let config=json_field(parse_json(consumer.body),"config")
  assert_true(json_field(config,"ack_wait")==200000000)
  let pull=api_request("consumer.next","EVENTS",consumer="WORKER",options={"batch":2,"expires_ms":1000})
  assert_true(json_field(parse_json(pull.body),"expires")==1000000000)
}

///|
test "every wire split keeps binary payload and FIFO controls unchanged" {
  let wire=b"INFO {\"max_payload\":1024}\r\nMSG events.a 9 4\r\n\x00\xff\r\n\r\nPING\r\n"
  for index = 0; index <= wire.length(); index=index+1 {
    let decoder=Decoder::new()
    let frames=[]
    for f in decoder.feed(wire[0:index].to_owned()) {frames.push(f)}
    for f in decoder.feed(wire[index:].to_owned()) {frames.push(f)}
    assert_true(frames.length()==3)
    assert_true(frames[1].payload==b"\x00\xff\r\n")
    assert_true(frames[2].kind=="PING")
    decoder.finish()
  }
}

///|
test "repeated UTF8 headers retain values and valid header tokens" {
  let header=@utf8.encode("NATS/1.0\r\nX.Trace: 中文\r\nX.Trace: second\r\n\r\n")
  let wire=@utf8.encode("HMSG events.a 1 \{header.length()} \{header.length()+4}\r\n")+header+b"data\r\n"
  let frame=Decoder::new().feed(wire)[0]
  assert_true(frame.headers.length()==2 && frame.headers[0].value=="中文")
  assert_true(frame.payload==b"data")
  ignore(publish("events.a",b"data",headers=[{name:"X.Trace",value:"value"}]))
}

///|
test "malformed and oversized frames poison parser until new decoder" {
  for wire in [b"MSG a 1 -1\r\n",b"MSG a 1 214748364700\r\n",b"MSG a 1 1\r\nxXX",b"HMSG a 1 8 4\r\n",b"UNKNOWN\r\n"] {
    let decoder=Decoder::new(max_payload=16)
    let rejected=try{ignore(decoder.feed(wire));false}catch{_=>true}
    assert_true(rejected)
    assert_true(try{ignore(decoder.feed(b"PING\r\n"));false}catch{_=>true})
  }
  let decoder=Decoder::new()
  assert_true(try{ignore(decoder.feed(b"a".repeat(4097)));false}catch{_=>true})
}

///|
test "EOF truncation and zero payload are distinguished" {
  let decoder=Decoder::new()
  assert_true(decoder.feed(b"MSG a 1 0\r\n\r\n")[0].payload.is_empty())
  decoder.finish()
  let partial=Decoder::new()
  ignore(partial.feed(b"MSG a 1 5\r\nab"))
  assert_true(try{partial.finish();false}catch{_=>true})
}

///|
test "subject header and subscription injection is rejected" {
  for subject in ["","a..b","a\r\nPING","a.>","a b","a.*.x"] {assert_true(try{validate_subject(subject);false}catch{_=>true})}
  validate_subject("events.中文")
  validate_subject("events.*",wildcards=true)
  assert_true(try{validate_subject("events.>.tail",wildcards=true);false}catch{_=>true})
  assert_true(try{ignore(publish("a",b"x",headers=[{name:"X",value:"unsafe\r\nY: z"}]));false}catch{_=>true})
  assert_true(try{ignore(publish("a",b"1234",headers=[{name:"X",value:"z"}],max_payload=4));false}catch{_=>true})
}

///|
test "publish ACK preserves exact uint64 decimal precision and API errors" {
  let source=#|{"stream":"EVENTS","seq":9007199254740993,"duplicate":true}
  let ack=publish_ack(source)
  assert_true(ack.sequence=="9007199254740993"&&ack.duplicate)
  let maximum=#|{"stream":"EVENTS","seq":18446744073709551615}
  assert_true(publish_ack(maximum).sequence=="18446744073709551615")
  assert_true(try{ignore(publish_ack("{\"stream\":\"EVENTS\",\"seq\":1.5}"));false}catch{_=>true})
  assert_true(try{ignore(api_response("{\"error\":{\"code\":404,\"err_code\":10059}}"));false}catch{_=>true})
}

///|
test "legacy and domain ACK subjects retain nanosecond timestamps" {
  let classic=ack_metadata("$JS.ACK.EVENTS.WORKER.2.4.5.1791888888888888888.0")
  assert_true(classic.delivered=="2"&&classic.stream_sequence=="4"&&classic.timestamp=="1791888888888888888")
  let domain=ack_metadata("$JS.ACK._.hash.EVENTS.WORKER.2.4.5.1791888888888888888.0.token")
  assert_true(domain.consumer==classic.consumer&&domain.timestamp==classic.timestamp)
  assert_true(try{ignore(ack_metadata("$JS.ACK.EVENTS.WORKER.0.0.0.1.0"));false}catch{_=>true})
}

///|
test "request options replay and ACK payloads are bounded and typed" {
  let request=api_request("consumer.create","EVENTS",consumer="REPLAY",options={"start_sequence":"9007199254740993"})
  assert_true(request.body.contains("9007199254740993"))
  let invalid_options : Array[Json]=[{"batch":257},{"batch":1.5},{"batch":null},{"unexpected":1}]
  for options in invalid_options {assert_true(try{ignore(api_request("consumer.next","EVENTS",consumer="WORKER",options~));false}catch{_=>true})}
  assert_true(acknowledgement("ack")==b"+ACK")
  assert_true(acknowledgement("nak",delay_ms=100)==b"-NAK {\"delay\":100000000}")
  assert_true(try{ignore(acknowledgement("nak",delay_ms=3600001));false}catch{_=>true})
}

///|
test "window and retry policy reject duplicate and unbounded work" {
  let window=Window::new(limit=1)
  window.reserve("r1")
  assert_true(window.count()==1)
  assert_true(try{window.reserve("r2");false}catch{_=>true})
  assert_true(try{window.reserve("r1");false}catch{_=>true})
  window.release("r1");window.reserve("r2");window.release("r2")
  assert_true(window.count()==0)
  assert_true(reconnect_delay(0)==100&&reconnect_delay(20)==5000)
  assert_true(try{ignore(reconnect_delay(21));false}catch{_=>true})
}
