///|
/// The public configuration catalogue follows NATS Server v2.15.1. Nested
/// configuration is preserved, not silently stripped; the broker remains the
/// authority for version-specific cross-field and immutable-field constraints.
pub fn configuration_fields(kind : String) -> Array[Header] raise ProtocolError {
  let groups : Array[(String, Array[String])] = match kind {
    "stream" =>
      [
        (
          "string",
          [
            "name", "description", "retention", "discard", "storage", "compression",
            "persist_mode",
          ],
        ),
        (
          "integer",
          [
            "max_consumers", "max_msgs", "max_bytes", "max_age", "max_msgs_per_subject",
            "max_msg_size", "num_replicas", "duplicate_window", "first_seq", "subject_delete_marker_ttl",
          ],
        ),
        (
          "boolean",
          [
            "no_ack", "allow_direct", "mirror_direct", "discard_new_per_subject",
            "sealed", "deny_delete", "deny_purge", "allow_rollup_hdrs", "allow_msg_ttl",
            "allow_msg_counter", "allow_atomic", "allow_msg_schedules", "allow_batched",
          ],
        ),
        ("strings", ["subjects"]),
        (
          "object",
          [
            "placement", "mirror", "subject_transform", "republish", "consumer_limits",
            "metadata",
          ],
        ),
        ("objects", ["sources"]),
      ]
    "consumer" =>
      [
        (
          "string",
          [
            "durable_name", "name", "description", "deliver_policy", "opt_start_time",
            "ack_policy", "filter_subject", "replay_policy", "sample_freq", "deliver_subject",
            "deliver_group", "pause_until", "priority_policy",
          ],
        ),
        (
          "integer",
          [
            "opt_start_seq", "ack_wait", "max_deliver", "rate_limit_bps", "max_waiting",
            "max_ack_pending", "max_batch", "max_expires", "max_bytes", "idle_heartbeat",
            "inactive_threshold", "num_replicas", "priority_timeout",
          ],
        ),
        (
          "boolean",
          ["flow_control", "headers_only", "mem_storage", "direct", "sourcing"],
        ),
        ("strings", ["filter_subjects", "priority_groups"]),
        ("integers", ["backoff"]),
        ("object", ["metadata"]),
      ]
    _ => raise Invalid("unknown configuration kind")
  }
  let result : Array[Header] = []
  for (value, names) in groups {
    for name in names {
      result.push({ name, value, })
    }
  }
  result
}

///|
pub fn validate_resource_name(name : String) -> Unit raise ProtocolError {
  guard name.length() > 0 && @utf8.encode(name).length() <= 255 else {
    raise Invalid("resource name budget")
  }
  for c in name {
    guard c > ' ' &&
      c != '\u007f' &&
      c != '.' &&
      c != '*' &&
      c != '>' &&
      c != '/' &&
      c != '\\' else {
      raise Invalid("unsafe resource name")
    }
  }
}

///|
/// Decimal strings are an explicit exact-integer input form, not JS rounding.
fn management_integer(value : Json) -> Json raise {
  let s = match value {
    String(s) => s
    Number(_, ..) => value.stringify()
    _ => raise Invalid("integer configuration required")
  }
  if s == "-1" {
    return Json(-1)
  }
  valid_sequence(s)
  @json.parse(s, preserve_number_repr=true)
}

///|
pub fn validate_configuration(kind : String, value : Json) -> Json raise {
  guard value is Object(map) && map.length() <= 128 else {
    raise Invalid("configuration object required")
  }
  let catalogue : Map[String, String] = Map([])
  for entry in configuration_fields(kind) {
    catalogue[entry.name] = entry.value
  }
  let out : Map[String, Json] = Map([])
  for (name, raw) in map {
    guard catalogue.get(name) is Some(t) else {
      raise Invalid("unknown configuration field: " + name)
    }
    let converted = match t {
      "integer" => management_integer(raw)
      "string" => {
        guard raw is String(_) else {
          raise Invalid("string configuration required")
        }
        raw
      }
      "boolean" => {
        guard raw is True || raw is False else {
          raise Invalid("boolean configuration required")
        }
        raw
      }
      "object" => {
        guard raw is Object(_) else {
          raise Invalid("object configuration required")
        }
        raw
      }
      "strings" | "integers" | "objects" => {
        guard raw is Array(xs) && xs.length() <= 4096 else {
          raise Invalid("configuration array budget")
        }
        let values : Array[Json] = []
        for x in xs {
          if t == "strings" {
            guard x is String(_) else { raise Invalid("string array required") }
            values.push(x)
          } else if t == "objects" {
            guard x is Object(_) else { raise Invalid("object array required") }
            values.push(x)
          } else {
            values.push(management_integer(x))
          }
        }
        Json(values)
      }
      _ => raise Invalid("unsupported configuration type")
    }
    out[name] = converted
  }
  for name in ["name", "durable_name"] {
    if out.get(name) is Some(String(s)) {
      validate_resource_name(s)
    }
  }
  for name in ["subjects", "filter_subjects"] {
    if out.get(name) is Some(Array(xs)) {
      for s in xs {
        validate_subject(text(s), wildcards=true)
      }
    }
  }
  for name in ["filter_subject", "deliver_subject"] {
    if out.get(name) is Some(String(s)) {
      validate_subject(s, wildcards=name == "filter_subject")
    }
  }
  guard !out.contains("filter_subject") || !out.contains("filter_subjects") else {
    raise Invalid("choose one consumer filter form")
  }
  let result = Json(out)
  // Reuse strict JSON structural/UTF-8 budgets; do not perform ambient IO.
  ignore(parse_json(result.stringify()))
  result
}

///|
pub struct StreamConfig {
  values : Json
}

///|
pub fn StreamConfig::new(
  name : String,
  subjects : Array[String],
) -> StreamConfig raise {
  let value : Json = { "name": Json(name), "subjects": Json(subjects) }
  { values: validate_configuration("stream", value), }
}

///|
pub fn StreamConfig::from_json(value : Json) -> StreamConfig raise {
  { values: validate_configuration("stream", value), }
}

///|
pub fn StreamConfig::json(self : StreamConfig) -> Json {
  self.values
}

///|
pub struct ConsumerConfig {
  values : Json
}

///|
pub fn ConsumerConfig::from_json(value : Json) -> ConsumerConfig raise {
  { values: validate_configuration("consumer", value), }
}

///|
pub fn ConsumerConfig::json(self : ConsumerConfig) -> Json {
  self.values
}

///|
/// Full configuration requests coexist with the unchanged legacy convenience API.
pub fn management_request(
  action : String,
  stream~ : String = "",
  consumer~ : String = "",
  options~ : Json = Json::empty_object(),
  prefix~ : String = "$JS.API",
) -> ApiRequest raise {
  validate_subject(prefix)
  guard options is Object(map) else {
    raise Invalid("management object required")
  }
  if stream != "" {
    validate_resource_name(stream)
  }
  if consumer != "" {
    validate_resource_name(consumer)
  }
  let mut body = options
  let subject = match action {
    "account.info" => {
      guard map.is_empty() else {
        raise Invalid("account info takes no options")
      }
      prefix + ".INFO"
    }
    "streams.list" => prefix + ".STREAM.LIST"
    "streams.names" => prefix + ".STREAM.NAMES"
    "stream.create" | "stream.update" => {
      guard stream != "" && json_field(options, "name") == Json(stream) else {
        raise Invalid("stream config identity mismatch")
      }
      body = validate_configuration("stream", options)
      prefix +
      (if action == "stream.create" {
        ".STREAM.CREATE."
      } else {
        ".STREAM.UPDATE."
      }) +
      stream
    }
    "stream.info" => prefix + ".STREAM.INFO." + stream
    "stream.delete" => prefix + ".STREAM.DELETE." + stream
    "stream.purge" => prefix + ".STREAM.PURGE." + stream
    "stream.snapshot" => prefix + ".STREAM.SNAPSHOT." + stream
    "stream.restore" => {
      guard json_field(options, "config") is Object(_) &&
        json_field(options, "state") is Object(state) else {
        raise Invalid("restore config and state required")
      }
      let config = validate_configuration(
        "stream",
        json_field(options, "config"),
      )
      guard json_field(config, "name") == Json(stream) else {
        raise Invalid("restore stream identity mismatch")
      }
      let normalized : Map[String, Json] = Map([])
      for (key, value) in state {
        if [
            "messages", "bytes", "first_seq", "last_seq", "consumer_count", "num_subjects",
            "num_deleted",
          ].contains(key) {
          normalized[key] = management_integer(value)
        } else if key == "deleted" && value is Array(xs) {
          normalized[key] = Json(xs.map(x => management_integer(x)))
        } else {
          normalized[key] = value
        }
      }
      body = { "config": config, "state": Json(normalized) }
      prefix + ".STREAM.RESTORE." + stream
    }
    "stream.peer.remove" => prefix + ".STREAM.PEER.REMOVE." + stream
    "stream.leader.stepdown" => prefix + ".STREAM.LEADER.STEPDOWN." + stream
    "stream.cancel.move" => prefix + ".STREAM.CANCEL_MOVE." + stream
    "message.get" => prefix + ".STREAM.MSG.GET." + stream
    "message.delete" => prefix + ".STREAM.MSG.DELETE." + stream
    "consumers.list" => prefix + ".CONSUMER.LIST." + stream
    "consumers.names" => prefix + ".CONSUMER.NAMES." + stream
    "consumer.info" => prefix + ".CONSUMER.INFO." + stream + "." + consumer
    "consumer.delete" => prefix + ".CONSUMER.DELETE." + stream + "." + consumer
    "consumer.pause" => prefix + ".CONSUMER.PAUSE." + stream + "." + consumer
    "consumer.leader.stepdown" =>
      prefix + ".CONSUMER.LEADER.STEPDOWN." + stream + "." + consumer
    "consumer.create" | "consumer.update" => {
      let config = validate_configuration("consumer", options)
      if consumer != "" {
        let n = json_field(config, "name")
        let d = json_field(config, "durable_name")
        guard (n == null || n == Json(consumer)) &&
          (d == null || d == Json(consumer)) else {
          raise Invalid("consumer config identity mismatch")
        }
      }
      body = {
        "stream_name": Json(stream),
        "config": config,
        "action": Json(
          if action == "consumer.create" {
            "create"
          } else {
            "update"
          },
        ),
      }
      prefix +
      ".CONSUMER.CREATE." +
      stream +
      (if consumer == "" { "" } else { "." + consumer })
    }
    _ => raise Invalid("unknown management operation")
  }
  if action != "account.info" && !action.has_prefix("streams.") {
    guard stream != "" else { raise Invalid("stream required") }
  }
  if [
      "consumer.info", "consumer.delete", "consumer.pause", "consumer.leader.stepdown",
    ].contains(action) {
    guard consumer != "" else { raise Invalid("consumer required") }
  }
  // Non-config request fields are validated as a full wire request by the server,
  // but local typo, injection, type and budget checks must not silently discard them.
  if ![
      "stream.create", "stream.update", "consumer.create", "consumer.update", "stream.restore",
    ].contains(action) {
    let allowed = match action {
      "streams.list" | "streams.names" => ["offset", "subject"]
      "consumers.list" | "consumers.names" => ["offset"]
      "stream.info" => ["offset", "subjects_filter", "deleted_details"]
      "stream.purge" => ["filter", "seq", "keep"]
      "message.get" => ["seq", "last_by_subj", "next_by_subj"]
      "message.delete" => ["seq", "no_erase"]
      "stream.snapshot" =>
        ["deliver_subject", "no_consumers", "chunk_size", "window_size", "jsck"]
      "stream.restore" => ["config", "state"]
      "stream.peer.remove" => ["peer"]
      "stream.leader.stepdown" | "consumer.leader.stepdown" => ["placement"]
      "consumer.pause" => ["pause_until"]
      _ => []
    }
    let normalized : Map[String, Json] = Map([])
    for (name, value) in map {
      guard allowed.contains(name) else {
        raise Invalid("unknown management request option")
      }
      if ["seq", "keep", "offset", "chunk_size", "window_size"].contains(name) {
        normalized[name] = management_integer(value)
      } else {
        normalized[name] = value
      }
    }
    body = Json(normalized)
  }
  let encoded = body.stringify()
  ignore(parse_json(encoded))
  { subject, body: encoded, }
}

///|
pub fn kv_subject(
  bucket : String,
  key : String,
  watch~ : Bool = false,
) -> String raise ProtocolError {
  token(bucket)
  validate_subject(key, wildcards=watch)
  for c in key {
    guard (c >= 'a' && c <= 'z') ||
      (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9') ||
      c == '_' ||
      c == '-' ||
      c == '/' ||
      c == '=' ||
      c == '.' ||
      (watch && (c == '*' || c == '>')) else {
      raise Invalid("invalid KV key")
    }
  }
  "$KV." + bucket + "." + key
}

///|
pub fn pool_index(attempt : Int32, size : Int32) -> Int32 raise ProtocolError {
  guard attempt >= 0 && size > 0 && size <= 32 else {
    raise Invalid("server pool budget")
  }
  attempt % size
}
