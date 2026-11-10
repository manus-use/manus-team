#!/usr/bin/env bash
# Installs manus-team from this checkout: builds it, makes the gateway's home,
# and puts mt on PATH. Safe to run again: it rebuilds, and never overwrites a
# config.yaml or a .env, nor adds the PATH line twice.
#
#   ./install.sh [--yes] [--service] [--node <path>]
#
#   --yes        append the PATH line to ~/.zshrc or ~/.bashrc without asking
#   --service    then run mt service install, to run the gateway as a service
#   --node PATH  the node to use; else nvm's newest 22.x, else the node on PATH
set -euo pipefail

usage() {
  echo 'usage: ./install.sh [--yes] [--service] [--node <path>]' >&2
  exit 2
}

say() { printf '%s\n' "$*"; }
die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

yes=false
service=false
node=''
while [ $# -gt 0 ]; do
  case "$1" in
    --yes | -y) yes=true ;;
    --service) service=true ;;
    --node)
      [ $# -ge 2 ] || usage
      node="$2"
      shift
      ;;
    -h | --help) usage ;;
    *) usage ;;
  esac
  shift
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- node 22.12 or later, nvm's 22 first --------------------------------------

# "major minor" of a node, or nothing when it does not run.
node_version() {
  local v
  v="$("$1" --version 2>/dev/null)" || return 0
  v="${v#v}"
  case "$v" in
    [0-9]*.[0-9]*.*) printf '%s %s\n' "${v%%.*}" "$(printf '%s' "$v" | cut -d. -f2)" ;;
  esac
}

new_enough() {
  local major minor
  read -r major minor <<<"$(node_version "$1")" || true
  [ -n "${major:-}" ] || return 1
  [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 12 ]; }
}

# The newest nvm 22.x that is 22.12 or later, by minor then patch, not by name.
nvm_node() {
  local dir best='' best_minor=-1 best_patch=-1 minor patch name
  local base="${NVM_DIR:-$HOME/.nvm}/versions/node"
  [ -d "$base" ] || return 0
  for dir in "$base"/v22.*; do
    [ -x "$dir/bin/node" ] || continue
    name="$(basename "$dir")"
    minor="$(printf '%s' "$name" | cut -d. -f2)"
    patch="$(printf '%s' "$name" | cut -d. -f3)"
    case "$minor$patch" in '' | *[!0-9]*) continue ;; esac
    [ -n "$minor" ] && [ -n "$patch" ] || continue
    if [ "$minor" -lt "$best_minor" ] || { [ "$minor" -eq "$best_minor" ] && [ "$patch" -le "$best_patch" ]; }; then
      continue
    fi
    if new_enough "$dir/bin/node"; then
      best="$dir/bin/node"
      best_minor="$minor"
      best_patch="$patch"
    fi
  done
  printf '%s' "$best"
}

if [ -z "$node" ]; then node="$(nvm_node)"; fi
if [ -z "$node" ]; then node="$(command -v node || true)"; fi
[ -n "$node" ] || die 'node 22.12 or later is needed, and none was found: install it, with nvm or otherwise'
case "$node" in /*) ;; *) node="$(cd "$(dirname "$node")" && pwd)/$(basename "$node")" ;; esac
[ -x "$node" ] || die "$node is not an executable node"
if ! new_enough "$node"; then
  die "node 22.12 or later is needed; $node is $("$node" --version 2>/dev/null || echo 'not runnable')"
fi
node_dir="$(dirname "$node")"

# npm beside that node, else the one on PATH.
if [ -x "$node_dir/npm" ]; then npm="$node_dir/npm"; else npm="$(command -v npm || true)"; fi
[ -n "$npm" ] || die 'npm was not found beside that node or on PATH'
say "node: $node ($("$node" --version))"

# --- build -------------------------------------------------------------------

# This node first on PATH, so npm's scripts and native builds use it too.
export PATH="$node_dir:$PATH"
(cd "$root" && "$npm" ci && "$npm" run build)
[ -f "$root/dist/mt.js" ] || die "the build wrote no $root/dist/mt.js"

# --- the gateway's home ------------------------------------------------------

home="${MT_HOME:-$HOME/.manus-team}"
case "$home" in /*) ;; *) die "MT_HOME must be an absolute path: $home" ;; esac
mkdir -p "$home"
chmod 700 "$home"
say "home: $home"

if [ -e "$home/config.yaml" ]; then
  say "kept $home/config.yaml"
else
  (umask 077 && cp "$root/config.example.yaml" "$home/config.yaml")
  say "wrote $home/config.yaml from config.example.yaml: edit it, at least lark.appId and workspace"
fi

# One argument in single quotes, for a line the user pastes: each ' becomes '\''.
# The replacement is in a variable, which bash 3.2 (macOS's /bin/bash) needs: it
# keeps the backslashes of one written inline.
quote() {
  local q="'\\''"
  printf "'%s'" "${1//\'/$q}"
}

if [ ! -e "$home/.env" ]; then
  say ''
  say "There is no $home/.env, which holds the gateway's secret. Create it in a shell"
  say 'that holds LARK_APP_SECRET; the line writes it without printing it, and refuses'
  say 'if it is not set:'
  say ''
  # shellcheck disable=SC2016 # the ${...} is for the user's shell, not this one
  say "  (umask 077; printf 'LARK_APP_SECRET=%s\\n' \"\${LARK_APP_SECRET:?is not set}\" > $(quote "$home/.env")) && chmod 600 $(quote "$home/.env")"
  say ''
fi

# --- mt on PATH --------------------------------------------------------------
#
# The launcher the gateway itself writes at each start, $MT_HOME/bin/mt: this
# checkout's dist/mt.js run by this node. Not npm link, which would put mt in
# the npm prefix's bin, under one nvm version, beside every other global
# command, and pointing at whichever checkout ran it last.

bin="$home/bin"
mkdir -p "$bin"
chmod 700 "$bin"
staging="$bin/.mt-install.$$"
{
  printf '#!/bin/sh\n'
  printf "# Written by install.sh: this checkout's mt, run by the node it chose. The gateway rewrites it at each start.\n"
  printf 'exec %s %s "$@"\n' "$(quote "$node")" "$(quote "$root/dist/mt.js")"
} >"$staging"
chmod 700 "$staging"
mv -f "$staging" "$bin/mt"
say "wrote $bin/mt"

path_line="export PATH=$(quote "$bin"):\"\$PATH\""
case ":$PATH:" in
  *":$bin:"*) say "$bin is on PATH already" ;;
  *)
    rc=''
    case "$(basename "${SHELL:-}")" in
      zsh) rc="$HOME/.zshrc" ;;
      # A login shell, which macOS's terminals start, reads ~/.bash_profile, not ~/.bashrc.
      bash) if [ "$(uname -s)" = Darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
    esac
    say "To put mt on PATH, add this line to your shell's rc file:"
    say "  $path_line"
    if [ -n "$rc" ]; then
      if [ -f "$rc" ] && grep -qxF "$path_line" "$rc"; then
        say "$rc has it already"
      else
        answer=n
        if $yes; then
          answer=y
        elif [ -t 0 ] && [ -t 1 ]; then
          read -r -p "Append it to $rc? [y/N] " answer || answer=n
        fi
        case "$answer" in
          y | Y | yes)
            printf '\n# manus-team: mt\n%s\n' "$path_line" >>"$rc"
            say "appended it to $rc; open a new shell, or run the line, to use mt"
            ;;
          *) say "left $rc as it is" ;;
        esac
      fi
    fi
    ;;
esac

# --- the service -------------------------------------------------------------

if $service; then
  "$bin/mt" service install
else
  say ''
  say 'To run the gateway as a service, which starts at login and restarts if it fails:'
  say '  mt service install'
fi
