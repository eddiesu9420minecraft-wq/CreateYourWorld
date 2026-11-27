#!/usr/bin/env bash
# Regenerates crates/pikara-secure/tests/fixtures with throw-away TEST keys.
# The private test keys are deleted at the end; only public keys + signed files are kept.
# This never touches the real Pikara release key.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=crates/pikara-secure/tests/fixtures
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"
TAURI="node node_modules/@tauri-apps/cli/tauri.js"

$TAURI signer generate -w "$TMP/test.key" -p "" --ci -f >/dev/null
$TAURI signer generate -w "$TMP/attacker.key" -p "" --ci -f >/dev/null
cp "$TMP/test.key.pub" "$OUT/test.pub"
cp "$TMP/attacker.key.pub" "$OUT/attacker.pub"

sign() { # key file -> writes file.sig
  $TAURI signer sign -k "$(cat "$TMP/$1.key")" -p "" "$2" >/dev/null
}

# --- artifact -------------------------------------------------------------
head -c 300000 /dev/urandom > "$OUT/artifact.bin"
sign test "$OUT/artifact.bin"
sha=$(sha256sum "$OUT/artifact.bin" | cut -d' ' -f1)
echo -n "$sha" > "$OUT/artifact.sha256"
cp "$OUT/artifact.bin" "$TMP/a2.bin" && sign attacker "$TMP/a2.bin" && cp "$TMP/a2.bin.sig" "$OUT/artifact.bin.attacker.sig"

# --- manifests ------------------------------------------------------------
PREFIX="https://github.com/eddiesu9420minecraft-wq/CreateYourWorld/releases/download"
sigb64=$(cat "$OUT/artifact.bin.sig")
manifest() { # name version date url product
  cat > "$OUT/$1.json" <<EOF
{"product":"$5","version":"$2","notes":"test","pub_date":"$3","platforms":{"windows-x86_64":{"url":"$4","signature":"$sigb64","sha256":"$sha","size":300000}}}
EOF
  sign test "$OUT/$1.json"
}
manifest good       0.2.0 2026-12-01T00:00:00Z "$PREFIX/v0.2.0/CYW_0.2.0_x64-setup.exe" create-your-world
manifest downgrade  0.0.9 2026-12-02T00:00:00Z "$PREFIX/v0.0.9/CYW_0.0.9_x64-setup.exe" create-your-world
manifest wrongtag   0.2.0 2026-12-01T00:00:00Z "$PREFIX/v0.1.5/CYW_0.1.5_x64-setup.exe" create-your-world
manifest httpurl    0.2.0 2026-12-01T00:00:00Z "http://github.com/eddiesu9420minecraft-wq/CreateYourWorld/releases/download/v0.2.0/x.exe" create-your-world
manifest evilhost   0.2.0 2026-12-01T00:00:00Z "https://github.com.evil.example/releases/download/v0.2.0/x.exe" create-your-world
manifest otherprod  0.2.0 2026-12-01T00:00:00Z "$PREFIX/v0.2.0/x.exe" pikara-science-studio
manifest olddate    0.2.0 2026-11-01T00:00:00Z "$PREFIX/v0.2.0/CYW_0.2.0_x64-setup.exe" create-your-world

# forged: valid manifest re-signed by the attacker key
cp "$OUT/good.json" "$TMP/forged.json" && sign attacker "$TMP/forged.json"
cp "$TMP/forged.json" "$OUT/forged.json" && cp "$TMP/forged.json.sig" "$OUT/forged.json.sig"
echo "fixtures written to $OUT"
