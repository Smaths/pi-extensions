#!/usr/bin/env bash
set -euo pipefail

# Link every top-level directory in this repository into Pi's user extension
# directory. Pass a directory to use a different destination.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
target_dir="${1:-${PI_EXTENSIONS_DIR:-$HOME/.pi/agent/extensions}}"

mkdir -p "$target_dir"
target_dir="$(cd "$target_dir" && pwd -P)"

linked=0
for source in "$repo_root"/*/; do
  [[ -d "$source" ]] || continue

  source="${source%/}"
  name="${source##*/}"

  destination="$target_dir/$name"

  if [[ -L "$destination" ]]; then
    if [[ "$(readlink "$destination")" == "$source" ]]; then
      printf 'already linked: %s\n' "$name"
      linked=$((linked + 1))
      continue
    fi
    rm "$destination"
  elif [[ -e "$destination" ]]; then
    printf 'error: refusing to replace existing path: %s\n' "$destination" >&2
    exit 1
  fi

  ln -s "$source" "$destination"
  printf 'linked: %s -> %s\n' "$name" "$source"
  linked=$((linked + 1))
done

printf 'Linked %d extension director%s into %s\n' \
  "$linked" "$([[ "$linked" == 1 ]] && printf 'y' || printf 'ies')" "$target_dir"
