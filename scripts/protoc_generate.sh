#!/usr/bin/env bash -x
set -euo pipefail
# Ensure git exists
git --version >/dev/null 2>&1 || { echo "Git is not installed!"; exit 1; }

MONOREPO_ROOT="$(git rev-parse --show-toplevel)"  # Keep for monorepo-wide (e.g., protoc_finalize.cjs)
LOCAL_DIR="$(pwd)"  # Workspace root (game/heroes-of-crypto-common)

# Binaries/paths: No PATH modification—rely on shell's PATH like manual command
PROTOC_BIN="${PROTOC_BIN:-protoc}"
PROTOC_GEN_TS_PATH="${LOCAL_DIR}/node_modules/.bin/protoc-gen-ts"

TREE="protobuf/v1"
SRC_DIR="${LOCAL_DIR}/protobuf/v1"
OUT_DIR="${LOCAL_DIR}/src/generated"
OUT_TREE="${OUT_DIR}/${TREE}"
DESC_OUT="${OUT_TREE}/types.protoset"

# Clean output
rm -rf "${OUT_DIR}"
mkdir -p "${OUT_TREE}"

# --- Collect protos (portable: works on macOS Bash 3) ---
PROTOS=()
while IFS= read -r -d '' f; do
  PROTOS+=("$f")
done < <(find "${SRC_DIR}" -type f -name '*.proto' -print0 | sort -z)

# Generate JS + d.ts
"${PROTOC_BIN}" \
  --plugin="protoc-gen-ts=${PROTOC_GEN_TS_PATH}" \
  --proto_path="${SRC_DIR}" \
  --js_out="import_style=commonjs,binary:${OUT_TREE}" \
  --ts_out="${OUT_TREE}" \
  "${PROTOS[@]}"

# Descriptor set for reading enum value options at runtime
"${PROTOC_BIN}" \
  --proto_path="${SRC_DIR}" \
  --include_imports \
  --include_source_info \
  --descriptor_set_out="${DESC_OUT}" \
  "${PROTOS[@]}"

echo "✓ Generated stubs into ${OUT_TREE}"
echo "✓ Wrote descriptor set to ${DESC_OUT}"

# Optional: StringList.toArray shim (append to the **.js** file, not .d.ts)
JS_FILE="${OUT_TREE}/types_pb.js"
if [ -f "${JS_FILE}" ]; then
  cat >> "${JS_FILE}" <<'EOS'
// ---- BEGIN shim: StringList.prototype.toArray ----
if (typeof exports.StringList === 'function' &&
    exports.StringList.prototype &&
    typeof exports.StringList.prototype.getValuesList === 'function' &&
    typeof exports.StringList.prototype.toArray !== 'function') {
  exports.StringList.prototype.toArray = function () {
    return this.getValuesList();
  };
}
// ---- END shim ----
EOS
  echo "✓ Added StringList.toArray shim to $(basename "${JS_FILE}")"
else
  echo "⚠ Skipped StringList shim; ${JS_FILE} not found"
fi

if command -v node >/dev/null 2>&1; then
  # Ensure generated stubs run as CommonJS, even in an ESM repo
  echo '{ "type": "commonjs" }' > "${OUT_TREE}/package.json"
  echo "✓ Wrote ${OUT_TREE}/package.json (type=commonjs)"
  # Now run finalize (assumes in monorepo root/scripts)
  node "${MONOREPO_ROOT}/scripts/protoc_finalize.cjs"
else
  echo "⚠ Node not found; skipped protoc_finalize.cjs"
fi

# Prepend // @ts-nocheck to every generated .ts file
echo "Adding // @ts-nocheck to all generated TypeScript files..."
find "${OUT_TREE}" -type f -name "*.ts" -print0 | while IFS= read -r -d '' file; do
  # Only add if not already present (idempotent)
  if ! head -n1 "$file" | grep -q "^// @ts-nocheck"; then
    # macOS/BSD sed needs backup extension; GNU sed doesn't care
    if sed --version >/dev/null 2>&1 2>&1; then
      sed -i "1i // @ts-nocheck" "$file"
    else
      sed -i '' "1i\\
// @ts-nocheck
" "$file"
    fi
  fi
done
echo "All generated .ts files now have // @ts-nocheck"
