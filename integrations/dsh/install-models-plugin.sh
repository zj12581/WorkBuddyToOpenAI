#!/usr/bin/env bash
#
# Install the workbuddy-models plugin into a DSH profile.
#
#   bash integrations/dsh/install-models-plugin.sh [profile]
#
# Defaults to the `web` profile.
#
# As with the balance plugin, the destination is $DSH_HOME/profiles/node_modules
# rather than the profile's own node_modules: DSH resolves plugin names from the
# profiles directory, and a copy under profiles/<name>/node_modules is unreachable
# (the loader silently never activates it).
#
# The sync script is copied next to the plugin rather than referenced from the
# repository, so the installed plugin keeps working if the checkout moves, and so
# there is one file to read when something is wrong.
#
set -euo pipefail

PROFILE="${1:-web}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PATCH="$PROFILE_DIR/cordis.patch.yml"
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="$SOURCE/plugin-workbuddy-models"
SCRIPT_SRC="$SOURCE/sync-models.js"

MODULES_DIR="$DSH_HOME/profiles/node_modules"
DEST="$MODULES_DIR/dsh-plugin-workbuddy-models"
ROW_ID="workbuddy-models"

say() { printf '[models-plugin] %s\n' "$*"; }
die() { printf '[models-plugin] %s\n' "$*" >&2; exit 1; }

[ -d "$PROFILE_DIR" ] || die "profile not found: $PROFILE_DIR"
[ -d "$PLUGIN_SRC" ] || die "plugin source not found: $PLUGIN_SRC"
[ -f "$SCRIPT_SRC" ] || die "sync script not found: $SCRIPT_SRC"
say "profile : $PROFILE_DIR"
say "modules : $MODULES_DIR"

# Remove a copy left by an older layout, so the resolved version is unambiguous.
STALE="$PROFILE_DIR/node_modules/dsh-plugin-workbuddy-models"
if [ -d "$STALE" ]; then
  rm -rf "$STALE"
  say "removed stale copy at $STALE"
fi

# 1. Plugin + the sync script it calls.
#
# The script lands as .cjs because the plugin's package.json sets
# "type": "module": a .js file in that package is parsed as ESM, and the script
# uses require().
mkdir -p "$DEST/lib"
cp "$PLUGIN_SRC/package.json" "$DEST/package.json"
cp "$PLUGIN_SRC/lib/index.js" "$DEST/lib/index.js"
cp "$SCRIPT_SRC" "$DEST/lib/sync-models.cjs"
say "installed: $DEST"

# 2. Loader row, unless present.
if [ ! -f "$PATCH" ]; then
  printf '# Your patch layer for this dsh profile.\n[]\n' > "$PATCH"
  say "created $PATCH"
fi

if grep -q "id: $ROW_ID" "$PATCH"; then
  say "loader row already present, leaving it alone"
else
  cat >> "$PATCH" <<EOF

# WorkBuddy 模型同步: /sync-models 把网关的模型清单写进本 profile 的 provider 配置。
- insert:
    - id: $ROW_ID
      name: dsh-plugin-workbuddy-models
EOF
  say "added loader row to $PATCH"
fi

# 3. Resolution + load check.
if command -v node >/dev/null 2>&1; then
  if (cd "$MODULES_DIR" && node -e "import('dsh-plugin-workbuddy-models').then(m=>process.exit(m.name==='workbuddy-models'?0:1)).catch(()=>process.exit(1))" 2>/dev/null); then
    say "resolution check passed"
  else
    say "warning: could not import the plugin by name from $MODULES_DIR"
  fi
  # The plugin loads the script lazily; a syntax error there would only surface at
  # first use, so check it now.
  if node --check "$DEST/lib/sync-models.cjs" 2>/dev/null; then
    say "vendored script parses"
  else
    say "warning: the vendored sync script does not parse"
  fi
  # Prove the plugin can actually reach the script, not just that it was copied.
  if (cd "$MODULES_DIR" && node -e "
    const p = require('path');
    const m = require(p.join('$DEST', 'lib', 'sync-models.cjs'));
    process.exit(typeof m.sync === 'function' ? 0 : 1);
  " 2>/dev/null); then
    say "vendored script loads and exports sync()"
  else
    say "warning: the vendored script did not export sync()"
  fi
  if [ -d "$PROFILE_DIR/node_modules/dsh-plugin-workbuddy-models" ]; then
    say "warning: a second copy still exists under $PROFILE_DIR/node_modules"
  fi
fi

say "done. Restart dsh (or rely on patchReload: live), then run /sync-models"
