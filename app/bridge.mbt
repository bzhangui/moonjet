///|
priv struct Session { decoder : @protocol.Decoder; window : @protocol.Window }
///|
let sessions : Map[String,Session] = Map([])
///|
fn value_text(value : Json, fallback? : String = "") -> String {
  match value { String(s)=>s; _=>fallback }
}
///|
fn session(id : String) -> Session raise {
  guard id.length()>0 && id.length()<=64 else { raise @protocol.Invalid("invalid session ID") }
  if sessions.get(id) is Some(current) { return current }
  guard sessions.length()<32 else { raise @protocol.Invalid("connection count budget exceeded") }
  let created={decoder:@protocol.Decoder::new(),window:@protocol.Window::new()}
  sessions[id]=created
  created
}
///|
fn hex(bytes : Bytes) -> String {
  let builder=StringBuilder()
  for byte in bytes { builder.write_string(byte.to_hex()) }
  builder.to_string()
}
///|
pub fn decode(arguments : String, bytes : Bytes) -> String {
  try {
    let args=@protocol.parse_json(arguments)
    let id=value_text(@protocol.json_field(args,"session"))
    if @protocol.json_field(args,"reset") is True { sessions.remove(id) }
    let current=session(id)
    let frames=current.decoder.feed(bytes)
    let values : Array[Json]=[]
    for frame in frames { values.push({"kind":Json(frame.kind),"subject":Json(frame.subject),"sid":Json(frame.sid),"reply":Json(frame.reply),"headers":Json(frame.headers),"status":Json(frame.status),"data":Json(hex(frame.payload))}) }
    let result : Json={"ok":true,"value":Json(values)}
    result.stringify()
  } catch { @protocol.Invalid(message) => { let result : Json={"ok":false,"error":Json(message)};result.stringify() }; _ => { let result : Json={"ok":false,"error":"malformed protocol input"}; result.stringify() } }
}
///|
pub fn encode(arguments : String, payload : Bytes) -> Bytes raise {
  let args=@protocol.parse_json(arguments)
  let subject=value_text(@protocol.json_field(args,"subject"))
  let id=value_text(@protocol.json_field(args,"sid"))
  match value_text(@protocol.json_field(args,"action")) {
    "pub" => {
      let headers : Array[@protocol.Header]=if @protocol.json_field(args,"headers")==null { [] } else { @json.from_json(@protocol.json_field(args,"headers")) }
      @protocol.publish(subject,payload,reply=value_text(@protocol.json_field(args,"reply")),headers~)
    }
    "sub" => @protocol.subscribe(subject,id)
    "unsub" => @protocol.unsubscribe(id)
    "ping" => b"PING\r\n"
    "pong" => b"PONG\r\n"
    "connect" => {
      let options=@protocol.json_field(args,"options")
      guard options is Object(_) else { raise @protocol.Invalid("CONNECT options must be object") }
      @utf8.encode("CONNECT "+options.stringify()+"\r\n")
    }
    _ => raise @protocol.Invalid("unsupported encoder operation")
  }
}
///|
fn command_impl(arguments : String) -> Json raise {
  let args=@protocol.parse_json(arguments)
  let current_action=value_text(@protocol.json_field(args,"action"))
  match current_action {
    "api" => Json(@protocol.api_request(value_text(@protocol.json_field(args,"operation")),value_text(@protocol.json_field(args,"stream")),consumer=value_text(@protocol.json_field(args,"consumer")),filter=value_text(@protocol.json_field(args,"filter"),fallback="events.>"),options=@protocol.json_field(args,"options"),prefix=value_text(@protocol.json_field(args,"prefix"),fallback="$JS.API")))
    "response" => @protocol.api_response(value_text(@protocol.json_field(args,"source")))
    "publish_ack" => Json(@protocol.publish_ack(value_text(@protocol.json_field(args,"source"))))
    "metadata" => Json(@protocol.ack_metadata(value_text(@protocol.json_field(args,"subject"))))
    "ack" => {
      let delay=match @protocol.json_field(args,"delay_ms") { Number(n,..)=>{guard n>=0.0 && n<=3600000.0 && n==n.to_int().to_double() else {raise @protocol.Invalid("invalid delay")};n.to_int()};_=>0 }
      Json(hex(@protocol.acknowledgement(value_text(@protocol.json_field(args,"kind")),delay_ms=delay)))
    }
    "reserve" => { session(value_text(@protocol.json_field(args,"session"))).window.reserve(value_text(@protocol.json_field(args,"key"))); Json(true) }
    "release" => { session(value_text(@protocol.json_field(args,"session"))).window.release(value_text(@protocol.json_field(args,"key"))); Json(true) }
    "close" => { sessions.remove(value_text(@protocol.json_field(args,"session"))); Json(true) }
    "retry" => { let n=match @protocol.json_field(args,"attempt") {Number(n,..)=>n;_=> -1.0};guard n>=0.0 && n<=20.0 && n==n.to_int().to_double() else {raise @protocol.Invalid("invalid attempt")};Json(@protocol.reconnect_delay(n.to_int())) }
    _ => raise @protocol.Invalid("unsupported core command")
  }
}
///|
pub fn command(arguments : String) -> String {
  try { let result : Json={"ok":true,"value":command_impl(arguments)};result.stringify() } catch {@protocol.Invalid(message)=>{let result : Json={"ok":false,"error":Json(message)};result.stringify()};_=>{let result : Json={"ok":false,"error":"malformed command or API response"};result.stringify()}}
}
