#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
case "$(uname -s)" in
  Darwin) extension=dylib ;;
  *) extension=so ;;
esac
for module in ExpoModulesCore UIKit; do
  swiftc -swift-version 5 -emit-module -emit-library -module-name "$module" \
    "tests/fixtures/$module.swift" -emit-module-path "$work/$module.swiftmodule" \
    -o "$work/lib$module.$extension"
done
# Same-file extension accesses private callbacks without adding production test hooks.
cat tests/fixtures/Transport.swift ios/T3WebSocketModule.swift tests/lifecycle.swift > "$work/main.swift"
swiftc -swift-version 5 -I "$work" -L "$work" -lExpoModulesCore -lUIKit \
  -Xlinker -rpath -Xlinker "$work" ios/VoiceReceiveWindow.swift "$work/main.swift" -o "$work/lifecycle"
"$work/lifecycle"
