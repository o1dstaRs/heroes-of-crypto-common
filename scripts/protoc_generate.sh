#!/usr/bin/env bash
set -euo pipefail

# Ensure git exists
git --version >/dev/null 2>&1 || { echo "Git is not installed!"; exit 1; }

ROOT_DIR="$(git rev-parse --show-toplevel)"

# Binaries/paths
export PATH="${PATH}:${ROOT_DIR}/node_modules/.bin"
PROTOC_BIN="${PROTOC_BIN:-protoc}"
PROTOC_GEN_TS_PATH="${ROOT_DIR}/node_modules/.bin/protoc-gen-ts"

TREE="protobuf/v1"
SRC_DIR="${ROOT_DIR}/protobuf/v1"
OUT_DIR="${ROOT_DIR}/src/generated"
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

  # Now run finalize
  node "${ROOT_DIR}/scripts/protoc_finalize.cjs"
else
  echo "⚠ Node not found; skipped protoc_finalize.cjs"
fi
