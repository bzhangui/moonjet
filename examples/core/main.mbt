///|
fn main {
  try {
    let message = @jet.Decoder::new().feed(b"MSG events.a 1 5\r\nhello\r\n")[0]
    guard message.payload == b"hello" else { abort("binary codec mismatch") }
    let create = @jet.api_request(
      "consumer.create",
      "EVENTS",
      consumer="WORKER",
      filter="events.>",
    )
    println(create.subject)
    println(create.body)
    let policy = @jet.DeliveryPolicy::new(
      max_deliveries=3,
      initial_delay_ms=50,
      max_delay_ms=75,
    )
    guard policy.on_failure("1").delay_ms == 50 &&
      policy.on_failure("2").delay_ms == 75 &&
      policy.on_failure("3").action == "stop" else {
      abort("bounded retry policy mismatch")
    }
    guard @jet.pull_status(409, "Batch Completed") == "end" &&
      @jet.pull_status(409, "Consumer Deleted") == "error" else {
      abort("pull status mismatch")
    }
    println("portable core: verified=true")
    let stream = @jet.StreamConfig::new("CONFIGURED", ["configured.>"])
    let plan = @jet.management_request(
      "stream.create",
      stream="CONFIGURED",
      options=stream.json(),
    )
    guard plan.subject == "$JS.API.STREAM.CREATE.CONFIGURED" else {
      abort("typed management mismatch")
    }
    let kv = @jet.kv_config("CACHE", 3, 0)
    guard @jet.json_field(kv, "name") == Json("KV_CACHE") else {
      abort("portable KV mismatch")
    }
    ignore(
      @jet.validate_object_info(
        {
          "bucket": "FILES",
          "name": "empty",
          "size": 0,
          "chunks": 0,
          "digest": "SHA-256=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
        "FILES",
        "empty",
      ),
    )
    println("portable management and storage guards: verified=true")
  } catch {
    _ => abort("portable core example failed")
  }
}
