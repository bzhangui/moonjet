///|
pub(all) suberror ProtocolError {
  Invalid(String)
} derive(Debug)

///|
pub extend ProtocolError with @debug.Debug::{to_repr}

///|
pub(all) struct Header {
  name : String
  value : String
} derive(Debug, ToJson, FromJson)

///|
pub extend Header with @debug.Debug::{to_repr}

///|
pub extend Header with ToJson::{to_json}

///|
pub extend Header with @json.FromJson::{from_json}

///|
pub(all) struct Frame {
  kind : String
  subject : String
  sid : String
  reply : String
  headers : Array[Header]
  status : Int32
  description : String
  payload : Bytes
} derive(Debug)

///|
pub extend Frame with @debug.Debug::{to_repr}

///|
pub struct Decoder {
  mut buffer : Array[Byte]
  max_payload : Int32
  mut failed : Bool
}

///|
pub fn Decoder::new(
  max_payload~ : Int32 = 1048576,
) -> Decoder raise ProtocolError {
  guard max_payload >= 0 && max_payload <= 8388608 else {
    raise Invalid("invalid payload budget")
  }
  { buffer: [], max_payload, failed: false, }
}

///|
pub fn validate_subject(
  subject : String,
  wildcards~ : Bool = false,
) -> Unit raise ProtocolError {
  guard subject.length() > 0 && @utf8.encode(subject).length() <= 512 else {
    raise Invalid("invalid subject size")
  }
  for c in subject {
    guard c > ' ' && c != '\u007f' else {
      raise Invalid("control character in subject")
    }
  }
  let tokens = subject.split(".").map(v => v.to_owned()).to_array()
  for i = 0; i < tokens.length(); i = i + 1 {
    let token = tokens[i]
    guard token.length() > 0 else { raise Invalid("empty subject token") }
    if token.contains("*") || token.contains(">") {
      guard wildcards &&
        (token == "*" || (token == ">" && i == tokens.length() - 1)) else {
        raise Invalid("invalid subject wildcard")
      }
    }
  }
}

///|
fn decimal(text : String, maximum : Int32) -> Int32 raise ProtocolError {
  guard text.length() > 0 && text.length() <= 10 else {
    raise Invalid("invalid protocol length")
  }
  let mut value = 0
  for c in text {
    guard c >= '0' && c <= '9' else {
      raise Invalid("non-decimal protocol length")
    }
    let digit = c.to_int() - 48
    guard value <= (maximum - digit) / 10 && digit <= maximum else {
      raise Invalid("protocol length exceeds budget")
    }
    value = value * 10 + digit
  }
  value
}

///|
fn token(text : String) -> Unit raise ProtocolError {
  guard text.length() > 0 && text.length() <= 64 else {
    raise Invalid("invalid protocol token")
  }
  for c in text {
    guard (c >= 'a' && c <= 'z') ||
      (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9') ||
      c == '_' ||
      c == '-' else {
      raise Invalid("unsafe protocol token")
    }
  }
}

///|
fn header_name(name : String) -> Unit raise ProtocolError {
  guard name.length() > 0 && name.length() <= 64 else {
    raise Invalid("invalid header name size")
  }
  for c in name {
    guard (c >= 'a' && c <= 'z') ||
      (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9') ||
      "!#$%&'*+-.^_`|~".contains_char(c) else {
      raise Invalid("invalid header name token")
    }
  }
}

///|
pub fn publish(
  subject : String,
  payload : Bytes,
  reply~ : String = "",
  headers~ : Array[Header] = [],
  max_payload~ : Int32 = 8388608,
) -> Bytes raise ProtocolError {
  validate_subject(subject)
  if reply != "" {
    validate_subject(reply)
  }
  guard max_payload >= 0 &&
    max_payload <= 8388608 &&
    payload.length() <= max_payload &&
    headers.length() <= 64 else {
    raise Invalid("publish budget exceeded")
  }
  let reply_text = if reply == "" { "" } else { " " + reply }
  if headers.is_empty() {
    return @utf8.encode("PUB \{subject}\{reply_text} \{payload.length()}\r\n") +
      payload +
      b"\r\n"
  }
  let mut header_text = "NATS/1.0\r\n"
  for header in headers {
    header_name(header.name)
    for c in header.value {
      guard c >= ' ' && c != '\u007f' else {
        raise Invalid("unsafe header value")
      }
    }
    header_text += header.name + ": " + header.value + "\r\n"
  }
  header_text += "\r\n"
  let header_bytes = @utf8.encode(header_text)
  guard header_bytes.length() <= 8192 &&
    header_bytes.length() + payload.length() <= max_payload else {
    raise Invalid("header/peer byte budget exceeded")
  }
  @utf8.encode(
    "HPUB \{subject}\{reply_text} \{header_bytes.length()} \{header_bytes.length()+payload.length()}\r\n",
  ) +
  header_bytes +
  payload +
  b"\r\n"
}

///|
pub fn subscribe(
  subject : String,
  sid : String,
  queue~ : String = "",
) -> Bytes raise ProtocolError {
  validate_subject(subject, wildcards=true)
  token(sid)
  if queue != "" {
    token(queue)
  }
  let middle = if queue == "" { "" } else { " " + queue }
  @utf8.encode("SUB \{subject}\{middle} \{sid}\r\n")
}

///|
pub fn unsubscribe(sid : String) -> Bytes raise ProtocolError {
  token(sid)
  @utf8.encode("UNSUB \{sid}\r\n")
}

///|
fn parse_headers(data : Bytes) -> (Array[Header], Int32, String) raise {
  let source = @utf8.decode(data)
  guard source.has_suffix("\r\n\r\n") else {
    raise Invalid("invalid header terminator")
  }
  let lines = source.split("\r\n").map(v => v.to_owned()).to_array()
  guard lines[0] == "NATS/1.0" || lines[0].has_prefix("NATS/1.0 ") else {
    raise Invalid("invalid header version")
  }
  let status = if lines[0] == "NATS/1.0" {
    0
  } else {
    let items = lines[0].split(" ").map(v => v.to_owned()).to_array()
    guard items.length() >= 2 && items[1].length() == 3 else {
      raise Invalid("invalid header status")
    }
    let code = decimal(items[1], 599)
    guard code >= 100 else { raise Invalid("invalid header status") }
    code
  }
  for c in lines[0] {
    guard c >= ' ' && c != '\u007f' else {
      raise Invalid("header status contains control")
    }
  }
  let headers = []
  for i = 1; i < lines.length() - 2; i = i + 1 {
    let line = lines[i]
    guard line != "" else { raise Invalid("early header terminator") }
    let pair = line
      .split_once(":")
      .unwrap_or_else(() => raise Invalid("header delimiter missing"))
    let name = pair.0.to_owned()
    header_name(name)
    for c in pair.1 {
      guard (c >= ' ' && c != '\u007f') || c == '\t' else {
        raise Invalid("header value contains control")
      }
    }
    let value = pair.1.trim().to_owned()
    headers.push({ name, value, })
    guard headers.length() <= 64 else { raise Invalid("header count exceeded") }
  }
  let description = if status != 0 && lines[0].length() > 12 {
    lines[0][13:].to_owned()
  } else {
    ""
  }
  (headers, status, description)
}

///|
fn Decoder::parse(self : Decoder, data : Bytes) -> Array[Frame] raise {
  guard data.length() <= 1048576 &&
    self.buffer.length() + data.length() <= self.max_payload + 1048576 + 12288 else {
    raise Invalid("receive byte budget exceeded")
  }
  for b in data {
    self.buffer.push(b)
  }
  let out = []
  let mut cursor = 0
  while cursor < self.buffer.length() {
    let mut line_end = cursor
    while line_end + 1 < self.buffer.length() &&
          !(self.buffer[line_end] == b'\r' && self.buffer[line_end + 1] == b'\n') {
      line_end += 1
    }
    guard line_end - cursor <= 4096 else {
      raise Invalid("control line budget exceeded")
    }
    if line_end + 1 >= self.buffer.length() {
      guard self.buffer.length() - cursor <= 4096 else {
        raise Invalid("incomplete control line budget exceeded")
      }
      break
    }
    let line = @utf8.decode(Bytes::from_array(self.buffer[cursor:line_end]))
    let parts = line
      .replace_all(old="\t", new=" ")
      .split(" ")
      .filter(v => !v.is_empty())
      .map(v => v.to_owned())
      .to_array()
    guard parts.length() > 0 else { raise Invalid("empty protocol operation") }
    let kind = parts[0].to_upper()
    if kind == "MSG" || kind == "HMSG" {
      let with_headers = kind == "HMSG"
      let minimum = if with_headers { 5 } else { 4 }
      guard parts.length() == minimum || parts.length() == minimum + 1 else {
        raise Invalid("invalid message control fields")
      }
      validate_subject(parts[1])
      token(parts[2])
      let reply = if parts.length() == minimum + 1 { parts[3] } else { "" }
      if reply != "" {
        validate_subject(reply)
      }
      let total = decimal(parts[parts.length() - 1], self.max_payload + 8192)
      let header_length = if with_headers {
        decimal(parts[parts.length() - 2], 8192)
      } else {
        0
      }
      guard header_length <= total && total - header_length <= self.max_payload else {
        raise Invalid("invalid header/payload length")
      }
      let start = line_end + 2
      if self.buffer.length() - start < total + 2 {
        break
      }
      guard self.buffer[start + total] == b'\r' &&
        self.buffer[start + total + 1] == b'\n' else {
        raise Invalid("payload terminator missing")
      }
      let payload = Bytes::from_array(
        self.buffer[start + header_length:start + total],
      )
      let (headers, status, description) = if with_headers {
        parse_headers(
          Bytes::from_array(self.buffer[start:start + header_length]),
        )
      } else {
        ([], 0, "")
      }
      out.push({
        kind,
        subject: parts[1],
        sid: parts[2],
        reply,
        headers,
        status,
        description,
        payload,
      })
      cursor = start + total + 2
    } else {
      guard ["INFO", "PING", "PONG", "+OK", "-ERR"].contains(kind) else {
        raise Invalid("unknown server operation")
      }
      if kind == "PING" || kind == "PONG" || kind == "+OK" {
        guard parts.length() == 1 else {
          raise Invalid("invalid control operation")
        }
      }
      let payload = if kind == "INFO" {
        guard line.length() > 5 else { raise Invalid("empty INFO") }
        @utf8.encode(line[5:].to_owned())
      } else if kind == "-ERR" {
        @utf8.encode(line)
      } else {
        b""
      }
      out.push({
        kind,
        subject: "",
        sid: "",
        reply: "",
        headers: [],
        status: 0,
        description: "",
        payload,
      })
      cursor = line_end + 2
    }
    guard out.length() <= 4096 else {
      raise Invalid("frame count budget exceeded")
    }
  }
  if cursor > 0 {
    let next = []
    for i = cursor; i < self.buffer.length(); i = i + 1 {
      next.push(self.buffer[i])
    }
    self.buffer = next
  }
  out
}

///|
pub fn Decoder::feed(self : Decoder, data : Bytes) -> Array[Frame] raise {
  guard !self.failed else {
    raise Invalid("decoder poisoned after protocol error")
  }
  errdefer {
    self.failed = true
  }
  self.parse(data)
}

///|
pub fn Decoder::finish(self : Decoder) -> Unit raise ProtocolError {
  guard !self.failed && self.buffer.is_empty() else {
    self.failed = true
    raise Invalid("truncated protocol frame")
  }
}
