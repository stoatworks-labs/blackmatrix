#!/usr/bin/env bash
# Assemble the embedded BlackMatrix app for the desktop bundle.
#
# BlackMatrix's server pulls a native addon (atem-connection depends on
# @julusian/freetype2), which cannot be inlined into a single-file bundle. So instead of esbuild we ship the compiled server `dist` plus a
# production `node_modules` carrying this platform's native prebuilds, laid out
# mirroring packages/{server,web}/dist so the server's import.meta.url-relative
# paths (../../web/dist) resolve unchanged. Node resolves the app's deps from the
# hoisted blackmatrix-app/node_modules.
#
# Produces src-tauri/node[.exe] and src-tauri/blackmatrix-app/ (both
# git-ignored; they ship inside the bundle). Run before `npm run tauri build`.
# Must run on the TARGET platform (native prebuilds are platform-specific); the
# release matrix does exactly that.
#
# NODE_PLATFORM overrides the embedded runtime arch (win-x64 / darwin-arm64 /
# darwin-x64 / linux-x64 / linux-arm64); defaults to the host.
set -euo pipefail

NODE_VERSION="v22.20.0"

detect_platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    MINGW*|MSYS*|CYGWIN*) os="win" ;;
    *) os="linux" ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64" ;;
    *) arch="x64" ;;
  esac
  echo "${os}-${arch}"
}

PLATFORM="${NODE_PLATFORM:-$(detect_platform)}"

HERE="$(cd "$(dirname "$0")/.." && pwd)"     # launcher/
REPO="$(cd "$HERE/.." && pwd)"               # blackmatrix repo root
TAURI="$HERE/src-tauri"
APP="$TAURI/blackmatrix-app"

echo "==> building BlackMatrix"
( cd "$REPO" && npm install && npm run build )

echo "==> staging server dist + web dist"
rm -rf "$APP"
mkdir -p "$APP/packages/server" "$APP/packages/web"
cp -R "$REPO/packages/server/dist" "$APP/packages/server/dist"
cp "$REPO/packages/server/package.json" "$APP/packages/server/package.json"
cp -R "$REPO/packages/web/dist" "$APP/packages/web/dist"

echo "==> installing production node_modules (with native prebuilds for $PLATFORM)"
# A minimal top-level manifest whose deps are the server's registry runtime deps.
# Workspace-local packages (@av/*) aren't on npm, so we drop them here and vendor
# their built output into node_modules afterwards.
node -e '
  const fs = require("fs");
  const pkg = require(process.argv[1]);
  const deps = Object.fromEntries(
    Object.entries(pkg.dependencies || {}).filter(([n]) => !n.startsWith("@av/")),
  );
  fs.writeFileSync(process.argv[2], JSON.stringify({
    name: "blackmatrix-app", private: true, type: "module", dependencies: deps,
  }, null, 2));
' "$REPO/packages/server/package.json" "$APP/package.json"
( cd "$APP" && npm install --omit=dev --no-audit --no-fund )

echo "==> vendoring workspace packages (@av/*) into node_modules"
# These are workspace-local and not on npm, so the production install above
# cannot resolve them. Their built output goes in by hand, under the name the
# server imports.
#
# The list is derived from the server's own dependencies rather than written out
# here: a hardcoded pair of packages silently shipped every v0.2.0 desktop
# bundle without @av/ascii-matrix, and a missing package only shows up at
# runtime, inside the installed app, as ERR_MODULE_NOT_FOUND.
mapping="$(node -e '
  const fs = require("fs"), path = require("path");
  const pkgs = path.join(process.argv[1], "packages");
  const dirOf = {};
  for (const dir of fs.readdirSync(pkgs)) {
    const manifest = path.join(pkgs, dir, "package.json");
    if (fs.existsSync(manifest)) {
      dirOf[JSON.parse(fs.readFileSync(manifest, "utf8")).name] = dir;
    }
  }
  const server = JSON.parse(fs.readFileSync(path.join(pkgs, "server", "package.json"), "utf8"));
  for (const name of Object.keys(server.dependencies || {})) {
    if (!name.startsWith("@av/")) continue;
    if (!dirOf[name]) throw new Error(`${name} is a server dependency but no packages/* provides it`);
    console.log(`${name}\t${dirOf[name]}`);
  }
' "$REPO")"

while IFS=$'\t' read -r name dir; do
  [ -n "$name" ] || continue
  echo "    $name <- packages/$dir"
  mkdir -p "$APP/node_modules/$name"
  cp -R "$REPO/packages/$dir/dist" "$APP/node_modules/$name/dist"
  cp "$REPO/packages/$dir/package.json" "$APP/node_modules/$name/package.json"
done <<< "$mapping"

# Belt and braces: whatever the built server actually imports must be on disk,
# or the bundle is dead on arrival in a way no build step would notice.
missing=""
for name in $(grep -rhoE '@av/[a-z0-9-]+' "$APP/packages/server/dist" | sort -u); do
  [ -d "$APP/node_modules/$name" ] || missing="$missing $name"
done
if [ -n "$missing" ]; then
  echo "ERROR: the server imports packages that were not vendored:$missing" >&2
  exit 1
fi

echo "==> fetching self-contained Node $NODE_VERSION ($PLATFORM)"
if [[ "$PLATFORM" == win-* ]]; then
  TARBALL="node-$NODE_VERSION-$PLATFORM"
  curl -sL "https://nodejs.org/dist/$NODE_VERSION/$TARBALL.zip" -o "$TAURI/node.zip"
  ( cd "$TAURI"
    if command -v unzip >/dev/null 2>&1; then unzip -q -o node.zip
    elif command -v 7z >/dev/null 2>&1; then 7z x -y node.zip >/dev/null
    else tar -xf node.zip; fi )
  cp "$TAURI/$TARBALL/node.exe" "$TAURI/node.exe"
  rm -rf "$TAURI/$TARBALL" "$TAURI/node.zip"
  echo "prepared: $TAURI/node.exe + $APP"
else
  TARBALL="node-$NODE_VERSION-$PLATFORM"
  curl -sL "https://nodejs.org/dist/$NODE_VERSION/$TARBALL.tar.gz" -o "$TAURI/node.tar.gz"
  tar xzf "$TAURI/node.tar.gz" -C "$TAURI"
  cp "$TAURI/$TARBALL/bin/node" "$TAURI/node"
  chmod +x "$TAURI/node"
  rm -rf "$TAURI/$TARBALL" "$TAURI/node.tar.gz"
  echo "prepared: $TAURI/node + $APP (server dist, web UI, prod node_modules)"
fi
