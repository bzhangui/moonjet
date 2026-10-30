///|
/// NKey wire envelope only. Ed25519 signing/key derivation is delegated to a
/// trusted cryptographic provider; do not implement a signature primitive here.
fn nkey_crc(bytes : Bytes) -> UInt32 {
  let mut crc = 0U
  for byte in bytes {
    crc = crc ^ (byte.to_uint() << 8)
    for _ in 0..<8 {
      crc = if (crc & 32768U) != 0U {
        ((crc << 1) ^ 4129U) & 65535U
      } else {
        (crc << 1) & 65535U
      }
    }
  }
  crc
}

///|
fn nkey_decode(source : String) -> Bytes raise ProtocolError {
  guard source.length() > 0 && source.length() <= 128 else {
    raise Invalid("invalid NKey size")
  }
  let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".to_array()
  let out : Array[Byte] = []
  let mut acc = 0U
  let mut bits = 0
  for c in source {
    let mut digit = -1
    for i, x in alphabet {
      if x == c {
        digit = i
      }
    }
    guard digit >= 0 else { raise Invalid("invalid NKey encoding") }
    acc = (acc << 5) | digit.reinterpret_as_uint()
    bits = bits + 5
    if bits >= 8 {
      bits = bits - 8
      out.push(((acc >> bits) & 255U).to_byte())
      acc = acc & ((1U << bits) - 1U)
    }
  }
  guard acc == 0U && bits < 5 else {
    raise Invalid("noncanonical NKey padding")
  }
  Bytes::from_array(out)
}

///|
fn nkey_encode(bytes : Bytes) -> String {
  let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".to_array()
  let out = StringBuilder()
  let mut acc = 0U
  let mut bits = 0
  for byte in bytes {
    acc = (acc << 8) | byte.to_uint()
    bits = bits + 8
    while bits >= 5 {
      bits = bits - 5
      out.write_char(alphabet[((acc >> bits) & 31U).reinterpret_as_int()])
    }
    acc = acc & ((1U << bits) - 1U)
  }
  if bits > 0 {
    out.write_char(alphabet[((acc << (5 - bits)) & 31U).reinterpret_as_int()])
  }
  out.to_string()
}

///|
pub fn decode_user_seed(source : String) -> Bytes raise ProtocolError {
  let value = nkey_decode(source)
  guard value.length() == 36 && value[0] == 149 && value[1] == 0 else {
    raise Invalid("user seed required")
  }
  let body = value[0:34].to_owned()
  let crc = nkey_crc(body)
  guard value[34].to_uint() == (crc & 255U) && value[35].to_uint() == crc >> 8 else {
    raise Invalid("invalid NKey checksum")
  }
  value[2:34].to_owned()
}

///|
pub fn encode_user_public(bytes : Bytes) -> String raise ProtocolError {
  guard bytes.length() == 32 else { raise Invalid("Ed25519 public key length") }
  let values : Array[Byte] = [160]
  for b in bytes {
    values.push(b)
  }
  let crc = nkey_crc(Bytes::from_array(values))
  values.push((crc & 255U).to_byte())
  values.push((crc >> 8).to_byte())
  nkey_encode(Bytes::from_array(values))
}
