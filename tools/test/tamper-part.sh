#!/bin/bash
# Flips 8 bytes inside CYW's partial self-update download on the REAL disk (run through WSL,
# which bypasses the Claude app container). Used to prove a tampered package is rejected.
set -euo pipefail
dir=/mnt/c/Users/EddieSu/AppData/Local/com.pikara.cyw/downloads
f=$(ls "$dir"/create-your-world-*.part)
ls -la "$f"
echo "before: $(sha256sum "$f" | cut -c1-16)"
printf '\xde\xad\xbe\xef\xde\xad\xbe\xef' | dd of="$f" bs=1 seek=1048576 conv=notrunc status=none
echo "tampered 8 bytes at offset 1048576"
echo "after:  $(sha256sum "$f" | cut -c1-16)"
