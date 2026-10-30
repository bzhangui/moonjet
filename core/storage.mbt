///|
/// Persisted and live headers share one strict NATS parser.
pub fn stored_headers(source : String) -> Array[Header] raise {
  let bytes = @utf8.encode(source)
  guard bytes.length() <= 16384 else { raise Invalid("stored header budget") }
  if bytes.length() == 0 {
    return []
  }
  let (headers, status, _) = parse_headers(bytes)
  guard status == 0 else { raise Invalid("persisted status header") }
  headers
}

///|
/// Portable KV wire configuration. Hosts supply persistence and scheduling.
pub fn kv_config(
  bucket : String,
  history : Int32,
  ttl_ms : Int32,
) -> Json raise {
  token(bucket)
  guard history >= 1 && history <= 64 && ttl_ms >= 0 else {
    raise Invalid("KV history or TTL budget")
  }
  validate_configuration("stream", {
    "name": Json("KV_" + bucket),
    "subjects": [Json(kv_subject(bucket, ">", watch=true))],
    "max_msgs_per_subject": Json(history),
    "max_age": parse_json((ttl_ms.to_int64() * 1000000L).to_string()),
    "allow_rollup_hdrs": true,
    "allow_direct": true,
    "deny_delete": true,
    "discard": "new",
    "storage": "file",
  })
}

///|
/// Validate object identity and bounded transfer counters on every host.
pub fn validate_object_info(
  value : Json,
  bucket : String,
  name : String,
) -> Json raise {
  token(bucket)
  guard name != "" && @utf8.encode(name).length() <= 512 else {
    raise Invalid("object name budget")
  }
  for c in name {
    guard c >= ' ' && c != '\u007f' else {
      raise Invalid("object name control")
    }
  }
  guard value is Object(_) &&
    json_field(value, "bucket") == Json(bucket) &&
    json_field(value, "name") == Json(name) else {
    raise Invalid("object identity mismatch")
  }
  for key in ["size", "chunks"] {
    guard json_field(value, key) is Number(_, ..) else {
      raise Invalid("object counters must be JSON integers")
    }
    let number = sequence_value(json_field(value, key))
    guard number.length() < 11 ||
      (number.length() == 11 && number <= "68719476736") else {
      raise Invalid("object size budget")
    }
  }
  let deleted = json_field(value, "deleted")
  guard deleted == null || deleted is True || deleted is False else {
    raise Invalid("object deleted must be boolean")
  }
  let opts = json_field(value, "options")
  guard opts == null || opts is Object(_) else {
    raise Invalid("object options must be object")
  }
  let link = json_field(opts, "link")
  if link != null {
    guard link is Object(_) && json_field(link, "bucket") is String(target) else {
      raise Invalid("object link must name a bucket")
    }
    token(target)
    if json_field(link, "name") != null {
      guard json_field(link, "name") is String(target_name) &&
        target_name != "" &&
        @utf8.encode(target_name).length() <= 512 else {
        raise Invalid("object link name budget")
      }
      for c in target_name {
        guard c >= ' ' && c != '\u007f' else {
          raise Invalid("object link name control")
        }
      }
    }
  }
  let nuid = json_field(value, "nuid")
  if nuid != null {
    guard nuid is String(id) else {
      raise Invalid("object chunk id must be string")
    }
    token(id)
  }
  if json_field(value, "deleted") != Json(true) &&
    json_field(json_field(value, "options"), "link") == null {
    guard json_field(value, "digest") is String(digest) &&
      digest.has_prefix("SHA-256=") &&
      digest.length() == 52 &&
      digest.has_suffix("=") else {
      raise Invalid("unsupported object digest")
    }
    for i = 8; i < 51; i = i + 1 {
      let c = digest[i]
      guard (c >= 'a' && c <= 'z') ||
        (c >= 'A' && c <= 'Z') ||
        (c >= '0' && c <= '9') ||
        c == '-' ||
        c == '_' else {
        raise Invalid("invalid object digest encoding")
      }
    }
    guard "AEIMQUYcgkosw048".contains(digest[50:51].to_owned()) else {
      raise Invalid("noncanonical object digest padding")
    }
  }
  ignore(parse_json(value.stringify()))
  value
}
