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
    println("portable core: verified=true")
  } catch {
    _ => abort("portable core example failed")
  }
}
