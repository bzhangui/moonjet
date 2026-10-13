///|
pub(all) struct ApiRequest { subject : String; body : String } derive(ToJson,FromJson,Debug)
///|
pub extend ApiRequest with ToJson::{to_json}
///|
pub extend ApiRequest with @json.FromJson::{from_json}
///|
pub extend ApiRequest with @debug.Debug::{to_repr}

///|
pub(all) struct PublishAck { stream : String; sequence : String; duplicate : Bool } derive(ToJson,Debug)
///|
pub extend PublishAck with ToJson::{to_json}
///|
pub extend PublishAck with @debug.Debug::{to_repr}

///|
pub(all) struct AckMetadata {
  stream : String
  consumer : String
  delivered : String
  stream_sequence : String
  consumer_sequence : String
  timestamp : String
  pending : String
} derive(ToJson,Debug)
///|
pub extend AckMetadata with ToJson::{to_json}
///|
pub extend AckMetadata with @debug.Debug::{to_repr}

///|
pub fn json_field(value : Json, key : String) -> Json {
  match value { Object(map) => map.get(key).unwrap_or(null); _ => null }
}

///|
fn text(value : Json) -> String raise ProtocolError {
  match value { String(s) => s; _ => raise Invalid("string expected") }
}

///|
pub fn parse_json(source : String) -> Json raise {
  guard source.length()<=1048576 && @utf8.encode(source).length()<=1048576 else { raise Invalid("API JSON budget exceeded") }
  let mut depth=0
  let mut quoted=false
  let mut escaped=false
  for c in source {
    if quoted { if escaped { escaped=false } else if c=='\\' { escaped=true } else if c=='"' { quoted=false }
    } else if c=='"' { quoted=true
    } else if c=='{' || c=='[' { depth+=1; guard depth<=24 else { raise Invalid("API JSON nesting budget exceeded") }
    } else if c=='}' || c==']' { depth-=1 }
  }
  @json.parse(source)
}

///|
fn option(options : Json, name : String, fallback : Int, minimum : Int, maximum : Int) -> Int raise ProtocolError {
  let value = json_field(options,name)
  if value == null { if options is Object(map) { guard !map.contains(name) else { raise Invalid("null is not a numeric option") } }; return fallback }
  guard value is Number(n,..) && n>=minimum.to_double() && n<=maximum.to_double() && n==n.to_int().to_double() else { raise Invalid("invalid bounded option: \{name}") }
  n.to_int()
}

///|
fn nanos(milliseconds : Int) -> Json {
  let value=milliseconds.to_int64()*1000000L
  Json::number(value.to_double(),repr="\{value}")
}

///|
fn valid_sequence(value : String) -> Unit raise ProtocolError {
  guard value.length()>0 && value.length()<=20 && !(value.length()>1 && value.has_prefix("0")) else { raise Invalid("invalid sequence") }
  let mut integer = 0UL
  for c in value {
    guard c>='0' && c<='9' else { raise Invalid("sequence must be decimal integer") }
    let digit=(c.to_int()-48).to_uint64()
    guard integer <= (18446744073709551615UL-digit)/10UL else { raise Invalid("sequence overflows 64-bit budget") }
    integer=integer*10UL+digit
  }
}

///|
pub fn sequence_value(value : Json) -> String raise ProtocolError {
  guard value is Number(_,..) else { raise Invalid("sequence JSON number required") }
  let source=value.stringify()
  valid_sequence(source)
  source
}

///|
pub fn api_request(action : String, stream : String, consumer? : String = "", filter? : String = "events.>", options? : Json = Json::empty_object(), prefix? : String = "$JS.API") -> ApiRequest raise ProtocolError {
  token(stream)
  if consumer!="" { token(consumer) }
  validate_subject(prefix)
  let allowed = match action { "stream.create" => ["max_msgs","max_bytes"]; "consumer.create" => ["ack_wait_ms","max_ack_pending","max_deliver","start_sequence"]; "consumer.next" => ["batch","expires_ms","max_bytes"]; "message.get"=>["sequence"];_=>[] }
  if options is Object(map) { for (key,_) in map { guard allowed.contains(key) else { raise Invalid("unsupported API option: \{key}") } } } else { guard options == null else { raise Invalid("options must be object") } }
  let mut subject = prefix
  let mut body : Json = Json::empty_object()
  match action {
    "stream.create" => {
      validate_subject(filter,wildcards=true)
      subject += ".STREAM.CREATE."+stream
      body={"name":Json(stream),"subjects":[Json(filter)],"storage":"file","retention":"limits","discard":"old","max_msgs":Json(option(options,"max_msgs",100000,1,1000000)),"max_bytes":Json(option(options,"max_bytes",16777216,1024,1073741824)),"duplicate_window":nanos(120000)}
    }
    "stream.info" => subject += ".STREAM.INFO."+stream
    "message.get" => {
      subject += ".STREAM.MSG.GET."+stream
      let sequence = text(json_field(options,"sequence"))
      valid_sequence(sequence)
      return {subject,body:"{\"seq\":"+sequence+"}"}
    }
    "consumer.create" => {
      guard consumer!="" else { raise Invalid("durable consumer required") }
      validate_subject(filter,wildcards=true)
      subject += ".CONSUMER.DURABLE.CREATE."+stream+"."+consumer
      let config : Map[String,Json] = Map([
        ("durable_name",Json(consumer)),("ack_policy",Json("explicit")),("filter_subject",Json(filter)),
        ("deliver_policy",Json("all")),("ack_wait",nanos(option(options,"ack_wait_ms",30000,100,300000))),
        ("max_ack_pending",Json(option(options,"max_ack_pending",32,1,4096))),
        ("max_deliver",Json(option(options,"max_deliver",5,1,100))),
      ])
      if json_field(options,"start_sequence") is String(sequence) {
        valid_sequence(sequence)
        guard sequence!="0" else { raise Invalid("start sequence must be positive") }
        config["deliver_policy"]="by_start_sequence"
        let text=Json(config).stringify()
        return {subject,body:"{\"stream_name\":"+Json(stream).stringify()+",\"config\":"+text[0:text.length()-1].to_owned()+",\"opt_start_seq\":"+sequence+"}}"}
      }
      guard json_field(options,"start_sequence")==null else { raise Invalid("start_sequence must be decimal string") }
      if options is Object(map) { guard !map.contains("start_sequence") else { raise Invalid("null start_sequence not supported") } }
      body={"stream_name":Json(stream),"config":Json(config)}
    }
    "consumer.info" => { guard consumer!="" else { raise Invalid("consumer required") }; subject += ".CONSUMER.INFO."+stream+"."+consumer }
    "consumer.next" => {
      guard consumer!="" else { raise Invalid("consumer required") }
      subject += ".CONSUMER.MSG.NEXT."+stream+"."+consumer
      body={"batch":Json(option(options,"batch",1,1,256)),"expires":nanos(option(options,"expires_ms",1000,10,30000)),"max_bytes":Json(option(options,"max_bytes",1048576,1,8388608))}
    }
    _ => raise Invalid("unsupported JetStream action")
  }
  {subject,body:body.stringify()}
}

///|
pub fn api_response(source : String) -> Json raise {
  let value=parse_json(source)
  guard value is Object(_) else { raise Invalid("API response must be object") }
  if json_field(value,"error") != null {
    raise Invalid("JetStream API error: code="+json_field(json_field(value,"error"),"code").stringify()+" err_code="+json_field(json_field(value,"error"),"err_code").stringify())
  }
  value
}

///|
pub fn publish_ack(source : String) -> PublishAck raise {
  let value=api_response(source)
  let stream=text(json_field(value,"stream")); token(stream)
  let sequence=sequence_value(json_field(value,"seq"))
  guard sequence!="0" else { raise Invalid("publish sequence must be positive") }
  let duplicate=json_field(value,"duplicate") is True
  guard json_field(value,"duplicate")==null || json_field(value,"duplicate") is True || json_field(value,"duplicate") is False else { raise Invalid("duplicate must be boolean") }
  {stream,sequence,duplicate}
}

///|
pub fn ack_metadata(subject : String) -> AckMetadata raise ProtocolError {
  validate_subject(subject)
  let parts=subject.split(".").map(v=>v.to_owned()).to_array()
  guard parts.length()==9 || parts.length()==11 || parts.length()==12 else { raise Invalid("unsupported ACK metadata shape") }
  guard parts[0]=="$JS" && parts[1]=="ACK" else { raise Invalid("not a JetStream ACK subject") }
  let start=if parts.length()==9 { 2 } else { 4 }
  token(parts[start]); token(parts[start+1])
  for i = start+2; i < start+7; i = i+1 { valid_sequence(parts[i]) }
  guard parts[start+2]!="0" && parts[start+3]!="0" && parts[start+4]!="0" else { raise Invalid("delivery sequences must be positive") }
  {stream:parts[start],consumer:parts[start+1],delivered:parts[start+2],stream_sequence:parts[start+3],consumer_sequence:parts[start+4],timestamp:parts[start+5],pending:parts[start+6]}
}

///|
pub fn acknowledgement(kind : String, delay_ms? : Int = 0) -> Bytes raise ProtocolError {
  guard delay_ms>=0 && delay_ms<=3600000 else { raise Invalid("invalid NAK delay") }
  match kind {
    "ack" => b"+ACK"
    "nak" => if delay_ms==0 { b"-NAK" } else { @utf8.encode("-NAK {\"delay\":\{delay_ms.to_int64()*1000000L}}") }
    "working" => b"+WPI"
    "term" => b"+TERM"
    _ => raise Invalid("unsupported acknowledgement")
  }
}

///|
pub struct Window { limit : Int; pending : Map[String,Bool] }

///|
pub fn Window::new(limit? : Int = 32) -> Window raise ProtocolError {
  guard limit>=1 && limit<=256 else { raise Invalid("invalid in-flight window") }
  {limit,pending:Map([])}
}

///|
pub fn Window::reserve(self : Window, key : String) -> Unit raise ProtocolError {
  token(key)
  guard !self.pending.contains(key) && self.pending.length()<self.limit else { raise Invalid("request window full or duplicate correlation ID") }
  self.pending[key]=true
}

///|
pub fn Window::release(self : Window, key : String) -> Unit { self.pending.remove(key) }

///|
pub fn Window::count(self : Window) -> Int { self.pending.length() }

///|
pub fn reconnect_delay(attempt : Int) -> Int raise ProtocolError {
  guard attempt>=0 && attempt<=20 else { raise Invalid("reconnect attempt budget exceeded") }
  let mut delay=100
  for i = 0; i < attempt; i=i+1 { delay=if delay>=2500 { 5000 } else { delay*2 } }
  delay
}
