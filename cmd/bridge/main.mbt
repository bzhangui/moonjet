///|
extern "js" fn install(decode : (String,Bytes)->String, encode : (String,Bytes)->Bytes, command : (String)->String) -> Unit =
  #| (decode,encode,command) => {globalThis.__moonjet_core={decode,encode,command};}
///|
fn main {
  install(@app.decode,(arguments,payload)=>try @app.encode(arguments,payload) catch { _ => b"" },@app.command)
}
