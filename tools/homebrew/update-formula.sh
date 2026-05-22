#!/usr/bin/env bash
#
# Update the Homebrew formula in deffenda/homebrew-tap from a release here.
#
# Usage:
#   tools/homebrew/update-formula.sh <version>
#
# Example:
#   tools/homebrew/update-formula.sh 1.1.0
#
# Requires:
#   - gh CLI authenticated
#   - shasum (macOS) or sha256sum (Linux)
#   - Write access to deffenda/homebrew-tap
#
# Closes #183.

set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Usage: $0 <version>  (e.g., 1.1.0)" >&2
  exit 2
fi

TEMPLATE="$(dirname "$0")/filemaker-vscode.rb.template"
if [ ! -f "$TEMPLATE" ]; then
  echo "Missing template: $TEMPLATE" >&2
  exit 1
fi

REPO="ABD-Enterprises/filemaker-data-api-for-vs-code"
TAP_REPO="deffenda/homebrew-tap"
VSIX_NAME="filemaker-data-api-tools-${VERSION}.vsix"
VSIX_URL="https://github.com/${REPO}/releases/download/v${VERSION}/${VSIX_NAME}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Downloading $VSIX_URL ..."
curl -fsSL -o "$WORK/$VSIX_NAME" "$VSIX_URL"

if command -v shasum >/dev/null 2>&1; then
  SHA256=$(shasum -a 256 "$WORK/$VSIX_NAME" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  SHA256=$(sha256sum "$WORK/$VSIX_NAME" | awk '{print $1}')
else
  echo "Need shasum or sha256sum" >&2
  exit 1
fi

echo "VSIX SHA256: $SHA256"

FORMULA_PATH="$WORK/filemaker-vscode.rb"
sed \
  -e "s|__VERSION__|${VERSION}|g" \
  -e "s|__VSIX_URL__|${VSIX_URL}|g" \
  -e "s|__VSIX_SHA256__|${SHA256}|g" \
  "$TEMPLATE" > "$FORMULA_PATH"

echo "Rendered formula:"
echo "----------------------------------------"
cat "$FORMULA_PATH"
echo "----------------------------------------"

echo "Cloning $TAP_REPO ..."
gh repo clone "$TAP_REPO" "$WORK/tap" -- --depth=1
mkdir -p "$WORK/tap/Formula"
cp "$FORMULA_PATH" "$WORK/tap/Formula/filemaker-vscode.rb"

cd "$WORK/tap"
git add Formula/filemaker-vscode.rb
git commit -m "feat: filemaker-vscode v${VERSION}" || {
  echo "No changes to commit (formula already up to date?)"
  exit 0
}
git push

echo "Done. Formula published to $TAP_REPO."
