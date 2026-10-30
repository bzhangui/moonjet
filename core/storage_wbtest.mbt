///|
test "portable KV configuration and stored header validation" {
  let config = kv_config("CACHE", 4, 123)
  assert_eq(json_field(config, "name"), Json("KV_CACHE"))
  assert_eq(json_field(config, "max_age").stringify(), "123000000")
  let headers = stored_headers("NATS/1.0\r\nKV-Operation: DEL\r\n\r\n")
  assert_eq(headers[0].value, "DEL")
  let rejected = try {
    ignore(stored_headers("NATS/1.0\r\nBad\r\n\r\n"))
    false
  } catch {
    _ => true
  }
  assert_true(rejected)
  let invalid = try {
    ignore(kv_config("CACHE", 65, 0))
    false
  } catch {
    _ => true
  }
  assert_true(invalid)
}

///|
test "portable object metadata fences identities counters and hash algorithm" {
  let value : Json = {
    "bucket": "B",
    "name": "x",
    "size": 0,
    "chunks": 0,
    "digest": "SHA-256=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  }
  ignore(validate_object_info(value, "B", "x"))
  let wrong = try {
    ignore(validate_object_info(value, "B", "other"))
    false
  } catch {
    _ => true
  }
  assert_true(wrong)
  let negative = try {
    ignore(
      validate_object_info(
        {
          "bucket": "B",
          "name": "x",
          "size": -1,
          "chunks": 0,
          "digest": "SHA-256=abc",
        },
        "B",
        "x",
      ),
    )
    false
  } catch {
    _ => true
  }
  assert_true(negative)
  let bad_values : Array[Json] = [
    { "bucket": "B", "name": "x", "size": "0", "chunks": 0 },
    { "bucket": "B", "name": "x", "size": 0, "chunks": 0, "deleted": "false" },
    { "bucket": "B", "name": "x", "size": 0, "chunks": 0, "options": [] },
    {
      "bucket": "B",
      "name": "x",
      "size": 0,
      "chunks": 0,
      "options": { "link": { "bucket": "bad.dot" } },
    },
    { "bucket": "B", "name": "x", "size": 0, "chunks": 0, "nuid": "bad.dot" },
    {
      "bucket": "B",
      "name": "x",
      "size": 0,
      "chunks": 0,
      "digest": "SHA-256=!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!=",
    },
  ]
  for item in bad_values {
    let rejected = try {
      ignore(validate_object_info(item, "B", "x"))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
}
