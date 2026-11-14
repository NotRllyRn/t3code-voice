#!/usr/bin/env bash
set -euo pipefail
usage() {
  printf '%s\n' 'Usage: run-simulator.sh --output NEW_ABSOLUTE_DIRECTORY --runtime INSTALLED_ID --device-type INSTALLED_ID --reviewed --startup-worker-cleared' \
    'LOCAL macOS only. Run only after independent review and coordination with the worker owning Maya.' \
    'Uses installed Xcode/SDK/runtime only. Creates a private, unique device set; never uses booted/default devices.' \
    'Preserves evidence and the owned, shut-down device set. No downloads, credentials, microphone permission, or product build.' \
    'Returns success only for a complete JSON transcript with every required gate PASS; UNVERIFIED is not success.' \
    'After inspecting evidence, remove only the exact output directory you supplied. No automatic recursive deletion.'
}
output= runtime= device_type= reviewed=0 cleared=0
while (($#)); do
  case "$1" in
    --output|--runtime|--device-type)
      (($# >= 2)) || { usage >&2; exit 2; }
      case "$1" in --output) output=$2 ;; --runtime) runtime=$2 ;; --device-type) device_type=$2 ;; esac
      shift 2 ;;
    --reviewed) reviewed=1; shift ;;
    --startup-worker-cleared) cleared=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ -n "$output" && -n "$runtime" && -n "$device_type" && $reviewed == 1 && $cleared == 1 ]] || { usage >&2; exit 2; }
[[ $(uname -s) == Darwin ]] || { echo 'Requires installed Apple tools on macOS; nothing run.' >&2; exit 2; }
[[ "$output" == /* && ! -e "$output" && ! -L "$output" ]] || { echo 'Output must be a new absolute path.' >&2; exit 2; }
for tool in xcrun python3 codesign shasum git uuidgen; do command -v "$tool" >/dev/null || { echo "Missing installed tool: $tool" >&2; exit 2; }; done
umask 077
mkdir "$output"
R=$(cd "$output" && pwd -P)
HERE=$(cd "$(dirname "$0")" && pwd -P)
ROOT=$(git -C "$HERE" rev-parse --show-toplevel)
MODULE="$HERE/../../ios"
UUID= BUNDLE="dev.t3.voice.engine.diagnostic.$(uuidgen | tr '[:upper:]' '[:lower:]')"
NAME="T3VoiceEngine-$(uuidgen)"
mkdir "$R/build" "$R/devices"
APP="$R/build/T3VoiceEngineDiagnostic.app"
mkdir "$APP"
# Every subprocess is bounded; stdout/stderr is private and capped, never an environment dump.
stage() {
  python3 - "$R" "$@" <<'PY'
import os, pathlib, signal, subprocess, sys
r, name, seconds, *command = sys.argv[1:]
r = pathlib.Path(r)
with (r / (name + '.log')).open('wb') as log:
    try:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            status = process.wait(timeout=int(seconds))
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)  # Only the process group just spawned here.
            process.wait()
            status = 124
    except OSError:
        status = 127
p = r / (name + '.log')
with p.open('r+b') as f:
    if p.stat().st_size > 1048576:
        f.truncate(1048576)
        status = 75
with (r / 'stages.tsv').open('a') as f:
    f.write(f'{name}\t{status}\n')
sys.exit(status if 0 <= status <= 255 else 1)
PY
}
cleanup() {
  local original=$?
  trap - EXIT
  if [[ -n "$UUID" ]]; then
    stage cleanup-terminate 20 xcrun simctl --set "$R/devices" terminate "$UUID" "$BUNDLE" || true
    if declare -F privacy >/dev/null; then privacy after || true; fi
    if stage cleanup-shutdown 40 xcrun simctl --set "$R/devices" shutdown "$UUID"; then
      printf '%s\n' 'owned-device-shutdown: PASS' > "$R/cleanup.txt"
    else
      printf '%s\n' 'owned-device-shutdown: UNVERIFIED (inspect cleanup-shutdown.log)' > "$R/cleanup.txt"
      original=1
    fi
  fi
  printf 'Evidence: %s\n' "$R"
  exit "$original"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
stage toolchain 20 xcrun swiftc --version
stage sdk 20 xcrun --sdk iphonesimulator --show-sdk-path
SDK=$(<"$R/sdk.log")
stage sdk-version 20 xcrun --sdk iphonesimulator --show-sdk-version
stage runtimes 30 xcrun simctl list runtimes -j
stage device-types 30 xcrun simctl list devicetypes -j
python3 - "$R" "$runtime" "$device_type" <<'PY'
import json, pathlib, sys
r = pathlib.Path(sys.argv[1]); runtime, device = sys.argv[2:]
runtimes = json.loads((r/'runtimes.log').read_text())['runtimes']
types = json.loads((r/'device-types.log').read_text())['devicetypes']
assert any(x['identifier'] == runtime and x.get('isAvailable') and x.get('platform') in (None, 'iOS')
           and x['identifier'].startswith('com.apple.CoreSimulator.SimRuntime.iOS-') for x in runtimes), 'Runtime not installed/available iOS'
assert any(x['identifier'] == device and x.get('productFamily') == 'iPhone' for x in types), 'Device type is not installed iPhone'
PY
case "$(uname -m)" in arm64) arch=arm64 ;; x86_64) arch=x86_64 ;; *) echo 'Unsupported host architecture' >&2; exit 2 ;; esac
cat "$MODULE/T3VoiceConversationModule.swift" "$HERE/EngineDiagnosticHost.swift" > "$R/build/Diagnostic.swift"
cp "$MODULE/T3VoiceConversationModule.swift" "$R/build/Production.swift.input"
cp "$MODULE/VoicePlaybackLedger.swift" "$R/build/VoicePlaybackLedger.swift"
python3 - "$R" "$ROOT" "$BUNDLE" "$runtime" "$device_type" "$SDK" "$arch" <<'PY'
import hashlib, json, pathlib, plistlib, subprocess, sys
r, root = map(pathlib.Path, sys.argv[1:3]); bundle, runtime, device, sdk, arch = sys.argv[3:]
plist = {'CFBundleIdentifier': bundle, 'CFBundleName': 'T3VoiceEngineDiagnostic',
 'CFBundleExecutable': 'T3VoiceEngineDiagnostic', 'CFBundlePackageType': 'APPL',
 'CFBundleVersion': '1', 'CFBundleShortVersionString': '1.0', 'MinimumOSVersion': '18.0',
 'LSRequiresIPhoneOS': True, 'UIDeviceFamily': [1], 'UILaunchScreen': {},
 'UIApplicationSceneManifest': {'UIApplicationSupportsMultipleScenes': False,
  'UISceneConfigurations': {'UIWindowSceneSessionRoleApplication': [
   {'UISceneConfigurationName': 'EngineDiagnostic', 'UISceneDelegateClassName': 'EngineDiagnosticScene'}]}}}
app = r/'build/T3VoiceEngineDiagnostic.app'
(app/'Info.plist').write_bytes(plistlib.dumps(plist))
changed = subprocess.check_output(['git', '-C', str(root), 'diff', '--name-only', 'HEAD', '-z']).split(b'\0')
hashes = {}
for raw in changed:
 if raw:
  p = root / raw.decode()
  if p.is_file() and not p.is_symlink(): hashes[raw.decode()] = hashlib.sha256(p.read_bytes()).hexdigest()
metadata = {'sourceSHA': subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'], text=True).strip(),
 'dirtyTrackedHashes': hashes, 'runtime': runtime, 'deviceType': device, 'sdk': sdk, 'arch': arch,
 'bundle': bundle, 'deviceSet': str(r/'devices'), 'scope': 'actual-engine-output-only-simulator',
 'reviewAcknowledged': True, 'startupWorkerCoordinationAcknowledged': True}
(r/'metadata.json').write_text(json.dumps(metadata, indent=2))
PY
flags=(-swift-version 5 -Onone -parse-as-library -D T3_VOICE_ENGINE_DIAGNOSTIC -sdk "$SDK" -target "$arch-apple-ios18.0-simulator" -framework UIKit -framework AVFoundation)
printf '%s\n' xcrun --sdk iphonesimulator swiftc "${flags[@]}" "$R/build/VoicePlaybackLedger.swift" "$R/build/Diagnostic.swift" -o "$APP/T3VoiceEngineDiagnostic" > "$R/compiler-argv.txt"
stage compile 180 xcrun --sdk iphonesimulator swiftc "${flags[@]}" "$R/build/VoicePlaybackLedger.swift" "$R/build/Diagnostic.swift" -o "$APP/T3VoiceEngineDiagnostic"
stage sign 30 codesign --force --sign - "$APP"
shasum -a 256 "$R/build/Production.swift.input" "$R/build/Diagnostic.swift" "$R/build/VoicePlaybackLedger.swift" "$HERE/EngineDiagnosticHost.swift" "$HERE/run-simulator.sh" "$APP/Info.plist" "$APP/T3VoiceEngineDiagnostic" > "$R/input-artifact-sha256.txt"
stage create 40 xcrun simctl --set "$R/devices" create "$NAME" "$device_type" "$runtime"
UUID=$(tr -d '\r\n' < "$R/create.log")
[[ "$UUID" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]] || { UUID=; echo 'Invalid created UUID' >&2; exit 1; }
printf '%s\n' "$UUID" > "$R/owned-device-uuid.txt"
stage boot 40 xcrun simctl --set "$R/devices" boot "$UUID"
stage bootstatus 120 xcrun simctl --set "$R/devices" bootstatus "$UUID" -b
privacy() {
  python3 - "$R" "$UUID" "$1" <<'PY'
import json, pathlib, sqlite3, sys
r = pathlib.Path(sys.argv[1]); device, phase = sys.argv[2:]
p = r/'devices'/device/'data/Library/TCC/TCC.db'
result = {'status':'UNVERIFIED', 'reason':'Owned Simulator TCC database unavailable'}
if p.is_file():
 try:
  with sqlite3.connect(p.as_uri() + '?mode=ro', uri=True) as db:
   count = db.execute("select count(*) from access where service = 'kTCCServiceMicrophone'").fetchone()[0]
  result = {'status':'OBSERVED', 'microphoneRows':count}
 except sqlite3.Error:
  result = {'status':'UNVERIFIED', 'reason':'Owned Simulator TCC database unreadable'}
(r/f'privacy-{phase}.json').write_text(json.dumps(result))
PY
}
privacy before
stage install 40 xcrun simctl --set "$R/devices" install "$UUID" "$APP"
launch_status=0
stage launch 40 xcrun simctl --set "$R/devices" launch --console "$UUID" "$BUNDLE" || launch_status=$?
privacy after
stage container 20 xcrun simctl --set "$R/devices" get_app_container "$UUID" "$BUNDLE" data
CONTAINER=$(<"$R/container.log")
# Poll only for persisted completion, never for audio progress or a launch-code success inference.
python3 - "$CONTAINER/Documents/result.json" "$R" <<'PY'
import json, pathlib, sys, time
source, r = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
deadline = time.monotonic() + 35
while not source.is_file() and time.monotonic() < deadline: time.sleep(0.2)
if not source.is_file(): raise SystemExit('FAIL: host did not persist a terminal transcript')
if source.stat().st_size > 8 * 1024 * 1024: raise SystemExit('FAIL: oversized transcript')
raw = source.read_bytes(); result = json.loads(raw)
(r/'result.json').write_bytes(raw)
PY
[[ $launch_status == 0 ]] || { echo 'Host process did not complete successfully; inspect launch.log and result.json.' >&2; exit 1; }
python3 - "$R/result.json" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
result = json.loads(path.read_bytes())
before = json.loads((path.parent/'privacy-before.json').read_text())
after = json.loads((path.parent/'privacy-after.json').read_text())
privacy = 'UNVERIFIED'
if before.get('status') == after.get('status') == 'OBSERVED':
 privacy = 'PASS' if before['microphoneRows'] == after['microphoneRows'] == 0 else 'FAIL'
(path.parent/'privacy-summary.json').write_text(json.dumps({'status': privacy, 'before':before, 'after':after}))
print('Owned Simulator microphone-row evidence:', privacy)
assert privacy != 'FAIL', 'Unexpected microphone authorization rows'
assert result.get('kind') == 'actual-engine-output-only-simulator'
required = result.get('requiredGates')
assert isinstance(required, list) and len(required) >= 25, 'Incomplete required gate list'
assert result.get('passed') is True and all(result.get('gates', {}).get(k) == 'PASS' for k in required), 'FAIL/UNVERIFIED gates: inspect result.json'
PY
