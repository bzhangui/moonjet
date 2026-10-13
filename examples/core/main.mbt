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
    println("portable core: verified=true")
  } catch {
    _ => abort("portable core example failed")
  }
}
