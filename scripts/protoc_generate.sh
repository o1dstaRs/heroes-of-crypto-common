#!/usr/bin/env bash

# Make sure that git is installed on the system
git --version 2>&1 >/dev/null
GIT_IS_AVAILABLE=$?

if [ $GIT_IS_AVAILABLE -ne 0 ]; then
  echo "Git is not installed!"
  exit $GIT_IS_AVAILABLE
fi

# Root directory of app
ROOT_DIR=$(git rev-parse --show-toplevel)

# Path to Protoc Plugin
PROTOC_GEN_TS_PATH="${ROOT_DIR}/node_modules/.bin/protoc-gen-ts"

TREE="protobuf/v1"

# Directory holding all .proto files
SRC_DIR="${ROOT_DIR}/protobuf/v1"

# Directory to write generated code (.d.ts files)
OUT_DIR="${ROOT_DIR}/src/generated"

# Clean all existing generated files
rm -r "${OUT_DIR}"
mkdir -p "${OUT_DIR}/${TREE}"

# Generate all messages
protoc \
    --plugin="protoc-gen-ts=${PROTOC_GEN_TS_PATH}" \
    --ts_opt=esModuleInterop=true \
    --js_out="import_style=commonjs,binary:${OUT_DIR}/${TREE}" \
    --ts_out="${OUT_DIR}/${TREE}" \
    --proto_path="${SRC_DIR}" \
    $(find "${SRC_DIR}" -iname "*.proto")

# this is a hack to avoid toArray errors coming from google-probufjs
JS_CODE="StringList.prototype.toArray = function () {
    return this.getValuesList();
};"
echo -e "$JS_CODE" >> "${OUT_DIR}/${TREE}/fight_pb.d.ts"
