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
