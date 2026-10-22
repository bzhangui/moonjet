///|
/// Bounded retry decisions are independent of sockets and timers.
pub struct DeliveryPolicy {
  max_deliveries : Int32
  initial_delay_ms : Int32
  max_delay_ms : Int32
} derive(ToJson, Debug)

///|
pub extend DeliveryPolicy with ToJson::{to_json}

///|
pub extend DeliveryPolicy with @debug.Debug::{to_repr}

///|
pub fn DeliveryPolicy::new(
  max_deliveries~ : Int32 = 5,
  initial_delay_ms~ : Int32 = 100,
  max_delay_ms~ : Int32 = 30000,
) -> DeliveryPolicy raise ProtocolError {
  guard max_deliveries >= 1 &&
    max_deliveries <= 100 &&
    initial_delay_ms >= 1 &&
    initial_delay_ms <= max_delay_ms &&
    max_delay_ms <= 3600000 else {
    raise Invalid("invalid delivery policy budget")
  }
  { max_deliveries, initial_delay_ms, max_delay_ms, }
}

///|
/// Stop means no ACK/TERM: retain the failure for operator inspection.
pub(all) struct DeliveryDecision {
  action : String
  delay_ms : Int32
} derive(ToJson, Debug)

///|
pub extend DeliveryDecision with ToJson::{to_json}

///|
pub extend DeliveryDecision with @debug.Debug::{to_repr}

///|
/// The decimal delivery count is never rounded through a floating point value.
pub fn DeliveryPolicy::on_failure(
  self : DeliveryPolicy,
  delivered : String,
) -> DeliveryDecision raise ProtocolError {
  valid_sequence(delivered)
  guard delivered != "0" else {
    raise Invalid("delivery count must be positive")
  }
  let limit = self.max_deliveries.to_string()
  if delivered.length() > limit.length() ||
    (delivered.length() == limit.length() && delivered >= limit) {
    return { action: "stop", delay_ms: 0, }
  }
  let mut count = 0
  for c in delivered {
    count = count * 10 + c.to_int() - 48
  }
  let mut delay = self.initial_delay_ms
  for i = 1; i < count; i = i + 1 {
    delay = if delay > self.max_delay_ms / 2 {
      self.max_delay_ms
    } else {
      delay * 2
    }
  }
  { action: "nak", delay_ms: delay, }
}

///|
test "delivery policy grows with exact cap and never silently terminates" {
  let policy = DeliveryPolicy::new(
    max_deliveries=10,
    initial_delay_ms=100,
    max_delay_ms=301,
  )
  assert_true(
    policy.on_failure("1").action == "nak" &&
    policy.on_failure("1").delay_ms == 100,
  )
  assert_true(policy.on_failure("2").delay_ms == 200)
  assert_true(policy.on_failure("3").delay_ms == 301)
  assert_true(policy.on_failure("9").delay_ms == 301)
  assert_true(policy.on_failure("10").action == "stop")
  assert_true(policy.on_failure("18446744073709551615").action == "stop")
  assert_true(
    DeliveryPolicy::new(initial_delay_ms=150, max_delay_ms=301).on_failure("2").delay_ms ==
    300,
  )
}

///|
test "delivery budgets and noncanonical uint64 counts fail closed" {
  for value in ["0", "01", "-1", "1.5", "18446744073709551616", ""] {
    assert_true(
      try {
        ignore(DeliveryPolicy::new().on_failure(value))
        false
      } catch {
        _ => true
      },
    )
  }
  assert_true(
    try {
      ignore(DeliveryPolicy::new(max_deliveries=101))
      false
    } catch {
      _ => true
    },
  )
  assert_true(
    try {
      ignore(DeliveryPolicy::new(initial_delay_ms=0))
      false
    } catch {
      _ => true
    },
  )
  assert_true(
    try {
      ignore(DeliveryPolicy::new(initial_delay_ms=301, max_delay_ms=300))
      false
    } catch {
      _ => true
    },
  )
  assert_true(
    try {
      ignore(DeliveryPolicy::new(max_delay_ms=3600001))
      false
    } catch {
      _ => true
    },
  )
  assert_true(
    DeliveryPolicy::new(max_deliveries=1).on_failure("1").action == "stop",
  )
  assert_true(
    DeliveryPolicy::new(
      max_deliveries=100,
      initial_delay_ms=3600000,
      max_delay_ms=3600000,
    ).on_failure("99").delay_ms ==
    3600000,
  )
}
