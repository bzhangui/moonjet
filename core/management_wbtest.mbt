///|
test "management catalogue covers all public v2.15.1 configuration fields" {
  assert_eq(configuration_fields("stream").length(), 38)
  assert_eq(configuration_fields("consumer").length(), 35)
  let stream = StreamConfig::new("FULL", ["events.>"])
  let r = management_request(
    "stream.create",
    stream="FULL",
    options=stream.json(),
  )
  assert_eq(r.subject, "$JS.API.STREAM.CREATE.FULL")
  let c = ConsumerConfig::from_json({
    "name": "C",
    "filter_subjects": ["a", "b"],
    "ack_policy": "explicit",
  })
  let req = management_request(
    "consumer.create",
    stream="FULL",
    consumer="C",
    options=c.json(),
  )
  assert_true(req.body.contains("create"))
}

///|
test "management config preserves exact integer policies and rejects unknown types" {
  let config = validate_configuration("stream", {
    "name": "A",
    "max_bytes": "9223372036854775807",
    "max_msgs": -1,
    "num_replicas": 3,
  })
  assert_true(config.stringify().contains("9223372036854775807"))
  let invalid : Array[Json] = [
    { "typo": true },
    { "max_msgs": 1.5 },
    { "no_ack": "yes" },
    { "sources": [1] },
    { "subjects": [1] },
  ]
  for input in invalid {
    let rejected = try {
      ignore(validate_configuration("stream", input))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
}

///|
test "management identity fields and paging form safe protocol subjects" {
  for
    action in [
      "stream.info", "stream.delete", "stream.purge", "stream.snapshot", "stream.cancel.move",
      "message.delete", "stream.peer.remove", "stream.leader.stepdown",
    ] {
    ignore(management_request(action, stream="A"))
  }
  for
    action in [
      "consumer.info", "consumer.delete", "consumer.pause", "consumer.leader.stepdown",
    ] {
    ignore(management_request(action, stream="A", consumer="C"))
  }
  for
    action in [
      "streams.list", "streams.names", "consumers.list", "consumers.names",
    ] {
    ignore(management_request(action, stream="A", options={ "offset": 0 }))
  }
  let wrong = try {
    ignore(
      management_request("stream.create", stream="A", options={ "name": "B" }),
    )
    false
  } catch {
    _ => true
  }
  assert_true(wrong)
  let restore = management_request("stream.restore", stream="A", options={
    "config": { "name": "A" },
    "state": {
      "messages": 1,
      "first_seq": "9007199254740993",
      "last_seq": "9007199254740993",
    },
  })
  assert_true(restore.body.contains("\"first_seq\":9007199254740993"))
  assert_eq(kv_subject("BUCKET", "a/b.c"), "$KV.BUCKET.a/b.c")
  assert_eq(kv_subject("BUCKET", ">", watch=true), "$KV.BUCKET.>")
  assert_eq(pool_index(100, 3), 1)
}

///|
test "NKey envelope roundtrip checksum padding and user prefix are portable" {
  let bytes : Array[Byte] = [149, 0]
  for _ in 0..<32 {
    bytes.push(7)
  }
  let crc = nkey_crc(Bytes::from_array(bytes))
  bytes.push((crc & 255U).to_byte())
  bytes.push((crc >> 8).to_byte())
  let encoded = nkey_encode(Bytes::from_array(bytes))
  assert_eq(decode_user_seed(encoded).length(), 32)
  assert_eq(
    encode_user_public(b"01234567890123456789012345678901").length(),
    56,
  )
  for invalid in ["", "aaaa", encoded + "A", "A" + encoded] {
    let rejected = try {
      ignore(decode_user_seed(invalid))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
}
