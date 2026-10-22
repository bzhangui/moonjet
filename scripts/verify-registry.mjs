import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {moon,moonEnv} from './build.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
const parent=path.join(root,'.local/registry-consumers');fs.mkdirSync(parent,{recursive:true});
const consumer=path.join(parent,randomUUID());fs.mkdirSync(consumer);
fs.writeFileSync(path.join(consumer,'moon.mod'),'name = "verification/moonjet"\nversion = "0.0.0"\n',{flag:'wx'});
fs.copyFileSync(path.join(root,'examples/core/moon.pkg'),path.join(consumer,'moon.pkg'),fs.constants.COPYFILE_EXCL);
fs.copyFileSync(path.join(root,'examples/core/main.mbt'),path.join(consumer,'main.mbt'),fs.constants.COPYFILE_EXCL);
const regression="///|\npub fn verify_patch() -> Unit raise {\n  let header = b\"NATS/1.0\\r\\nX: a\\x00b\\r\\n\\r\\n\"\n  let wire = @utf8.encode(\"HMSG inbox 1 \\{header.length()} \\{header.length()}\\r\\n\") + header + b\"\\r\\n\"\n  assert_true(try { ignore(@jet.Decoder::new().feed(wire)); false } catch { _ => true })\n  ignore(@jet.parse_json(\"{\\\"data\\\":\\\"\" + \"a\".repeat(1100000) + \"\\\"}\"))\n}\n///|\ntest \"independent registered patch behavior\" { verify_patch() }\n";
const regressionFolder=path.join(consumer,'patch');fs.mkdirSync(regressionFolder);
fs.writeFileSync(path.join(regressionFolder,'moon.pkg'),"import { \"bzhangui/moonjet/core\" @jet, \"moonbitlang/core/encoding/utf8\" @utf8 }\n",{flag:'wx'});
fs.writeFileSync(path.join(regressionFolder,'regression.mbt'),regression,{flag:'wx'});
fs.writeFileSync(path.join(regressionFolder,'delivery.mbt'),`///|
test "registered public delivery policy caps retry and rejects overflow" {
  let policy = @jet.DeliveryPolicy::new(max_deliveries=3, initial_delay_ms=100, max_delay_ms=150)
  assert_true(policy.on_failure("1").delay_ms == 100)
  assert_true(policy.on_failure("2").delay_ms == 150)
  assert_true(policy.on_failure("3").action == "stop")
  assert_true(policy.on_failure("18446744073709551615").action == "stop")
  assert_true(@jet.pull_status(409, "Batch Completed") == "end")
  assert_true(@jet.pull_status(409, "Consumer Deleted") == "error")
  assert_true(@jet.pull_status(409, "Message Size Exceeds MaxBytes", received=1) == "end")
  assert_true(@jet.pull_status(409, "Message Size Exceeds MaxBytes") == "error")
  assert_true(try { ignore(policy.on_failure("18446744073709551616")); false } catch { _ => true })
}
`,{flag:'wx'});
function run(args){const result=spawnSync(moon,args,{cwd:consumer,env:moonEnv,stdio:'inherit'});if(result.error||result.status!==0)throw new Error('Independent registry consumer failed: '+args.join(' '));}
run(['add','bzhangui/moonjet@'+version]);
for(const target of ['js','wasm','wasm-gc','native']){run(['check','--target',target,'--deny-warn']);run(['build','--target',target,'--release','--deny-warn']);run(['run','.', '--target',target]);run(['test','--target',target,'--deny-warn']);}
fs.writeFileSync(path.join(consumer,'verification.json'),JSON.stringify({module:'bzhangui/moonjet',version,registry_dependency:true,local_source_copy:false,targets:['js','wasm','wasm-gc','native'],delivery_policy_verified:true,regression_cases_per_target:2,ok:true},null,2),{flag:'wx'});
console.log(JSON.stringify({ok:true,module:'bzhangui/moonjet@'+version,consumer}));

