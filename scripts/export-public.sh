#!/usr/bin/env bash
# Assemble the PUBLIC repository from this private monorepo.
#
# The public repo ships the desktop app only — no server, no admin panel, no business
# docs — and starts with a fresh history (this repo's history contains server code, so it
# can never be published as-is). Run, inspect the output, then push it as a new repo.
#
#   ./scripts/export-public.sh ~/Projects/vibetranslate-public
set -euo pipefail

DEST="${1:-}"
if [ -z "$DEST" ]; then
  echo "usage: $0 <target-dir>" >&2
  exit 1
fi
if [ -e "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ]; then
  echo "refusing to write into non-empty $DEST" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$DEST"

echo "==> copying application sources"
# Only files git tracks: keeps build output, node_modules and local scratch out by design.
copy_tracked() {
  local prefix="$1"
  (cd "$ROOT" && git ls-files -z "$prefix") | while IFS= read -r -d '' f; do
    mkdir -p "$DEST/$(dirname "$f")"
    cp "$ROOT/$f" "$DEST/$f"
  done
}
copy_tracked src
copy_tracked src-tauri
copy_tracked public
# All of scripts/: the build itself calls into these (copy-vad-assets.mjs runs in the
# prebuild step), so cherry-picking files here silently breaks `pnpm build` downstream.
copy_tracked scripts

# Root-level config: copy everything git tracks at the top level EXCEPT an explicit
# denylist. Allowlisting was a trap — tailwind.config.js and postcss.config.js were simply
# forgotten, and the app then builds "successfully" with zero styles, which is far worse
# than a build error because the contributor assumes they broke it.
ROOT_DENY="AGENTS.md docker-compose.yml .env.example README.md"
(cd "$ROOT" && git ls-files --full-name | grep -v "/") | while read -r f; do
  case " $ROOT_DENY " in
    *" $f "*) continue ;;
  esac
  cp "$ROOT/$f" "$DEST/$f"
done

echo "==> adding public-only files (license, readme, contributing, workflow)"
cp -R "$ROOT/packaging/public/." "$DEST/"

# Deliberately NO docs/: every file in there is an internal working log. A leak audit found
# the offline-models roadmap disclosing exact free-tier quotas, the header the quota keys on
# (i.e. how to rotate around it), the kill-switch value, a competitor teardown, and an
# unresolved model-license question. A public roadmap, if wanted, must be written fresh.

echo "==> sanity checks"
fail=0
for forbidden in server worker admin landing docker docs packaging; do
  if [ -e "$DEST/$forbidden" ]; then echo "LEAK: $forbidden present"; fail=1; fi
done
# Any credential-shaped string is a hard stop, not a warning.
if grep -rIlE "gsk_[A-Za-z0-9]{20,}|AIzaSy[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}" "$DEST" 2>/dev/null | grep -q .; then
  echo "LEAK: credential-shaped string found"; fail=1
fi
[ "$fail" -eq 0 ] || { echo "export FAILED sanity checks"; exit 1; }

# Every script referenced by a package.json script must exist, or the public repo builds
# on the maintainer's machine and fails for everyone else.
echo "==> checking build-critical configs"
if grep -q "@tailwind" "$DEST/src/styles.css" 2>/dev/null; then
  for cfg in tailwind.config.js postcss.config.js; do
    [ -f "$DEST/$cfg" ] || { echo "MISSING $cfg while src/styles.css uses @tailwind -> the UI would build unstyled"; exit 1; }
  done
  echo "  tailwind + postcss config present"
fi

echo "==> checking package.json script references"
python3 - "$DEST" <<'PYEOF'
import json, re, sys, pathlib
dest = pathlib.Path(sys.argv[1])
pkg = json.loads((dest / "package.json").read_text())
missing = []
for name, cmd in pkg.get("scripts", {}).items():
    for ref in re.findall(r"(?:node|tsx|bun)\s+([\w./-]+\.(?:mjs|cjs|js|ts))", cmd):
        if not (dest / ref).exists():
            missing.append(f"{name}: {ref}")
if missing:
    print("MISSING SCRIPT FILES:")
    for m in missing:
        print("  " + m)
    sys.exit(1)
print("  all referenced scripts present")
PYEOF

echo "==> done: $DEST"
echo "next:"
echo "  cd $DEST && git init && git add -A && git commit -m 'Initial public release'"
echo "  gh repo create vibetranslate --public --source=. --push"
echo "  then add secrets: TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
