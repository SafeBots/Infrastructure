#!/usr/bin/env bash
# resolve-digests.sh — turn every image-digest PLACEHOLDER in the tree into a
# real @sha256 digest, in one command.
#
# Inductive security requires every image pinned by digest (not tag). The tree
# ships with placeholders (REPLACE_*_DIGEST) so it's reviewable without network
# access; this script resolves them all at build time against live registries.
#
# It does NOT touch nixpkgs (flake.nix PIN_ME_TO_A_COMMIT_SHA) — that's a
# deliberate human choice of an audited commit, not a mechanical lookup. See
# the note at the end.
#
# Usage:
#   ./resolve-digests.sh            # resolve everything, rewrite in place
#   ./resolve-digests.sh --check    # report unresolved placeholders, change nothing
#   ./resolve-digests.sh --print    # print the resolved digests, change nothing
#
# Requires: docker (for `docker manifest inspect`) OR skopeo. Network to the
# registries. Run it, review the diff, commit.
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-resolve}"

# placeholder-token -> real image:tag to resolve.
# Add a line here if a new placeholder token is introduced.
declare -A MAP=(
  [REPLACE_WITH_REAL_DIGEST_node20alpine]="node:20-alpine"
  [REPLACE_WITH_REAL_DIGEST_llamacpp_server]="ghcr.io/ggerganov/llama.cpp:server"
  [REPLACE_WITH_REAL_DIGEST_ffmpeg]="linuxserver/ffmpeg:latest"
  [REPLACE_WITH_REAL_DIGEST_typesense26]="typesense/typesense:26.0"
  [REPLACE_WITH_REAL_DIGEST_browserless]="browserless/chrome:latest"
  [REPLACE_python311slim_DIGEST]="python:3.11-slim"
  [REPLACE_python312slim_DIGEST]="python:3.12-slim"
)

# resolve <image:tag> -> sha256:...   (docker preferred, skopeo fallback)
resolve() {
  local ref="$1" digest=""
  if command -v docker >/dev/null 2>&1; then
    # `docker manifest inspect --verbose` returns the descriptor digest.
    digest="$(docker manifest inspect "$ref" 2>/dev/null \
      | grep -m1 -oE '"digest": *"sha256:[a-f0-9]{64}"' \
      | grep -oE 'sha256:[a-f0-9]{64}' || true)"
    if [ -z "$digest" ]; then
      # Fallback: pull + inspect RepoDigests (works when manifest API is picky).
      docker pull "$ref" >/dev/null 2>&1 || true
      digest="$(docker inspect --format '{{index .RepoDigests 0}}' "$ref" 2>/dev/null \
        | grep -oE 'sha256:[a-f0-9]{64}' || true)"
    fi
  elif command -v skopeo >/dev/null 2>&1; then
    digest="$(skopeo inspect "docker://$ref" 2>/dev/null \
      | grep -m1 -oE 'sha256:[a-f0-9]{64}' || true)"
  else
    echo "ERROR: need docker or skopeo to resolve digests." >&2; exit 1
  fi
  [ -n "$digest" ] || { echo "ERROR: could not resolve $ref" >&2; return 1; }
  echo "$digest"
}

# Files that may contain placeholders.
mapfile -t FILES < <(grep -rl "REPLACE_" \
  --include="*.yml" --include="Dockerfile" --include="*.nix" . 2>/dev/null \
  | grep -v node_modules || true)

if [ "$MODE" = "--check" ]; then
  n="$(grep -rho "REPLACE_[A-Za-z0-9_]*" "${FILES[@]}" 2>/dev/null | sort -u | wc -l || echo 0)"
  echo "Unresolved placeholder tokens: $n"
  grep -rho "REPLACE_[A-Za-z0-9_]*" "${FILES[@]}" 2>/dev/null | sort -u | sed 's/^/  /'
  [ "$n" -eq 0 ] && echo "All resolved." || echo "Run without --check to resolve."
  exit 0
fi

# Resolve each token once, then rewrite everywhere it appears.
declare -A RESOLVED
for token in "${!MAP[@]}"; do
  ref="${MAP[$token]}"
  # only resolve tokens actually present
  if grep -rq "$token" "${FILES[@]}" 2>/dev/null; then
    echo "Resolving $token  ($ref) ..."
    d="$(resolve "$ref")"
    RESOLVED[$token]="$d"
    echo "  -> $d"
  fi
done

if [ "$MODE" = "--print" ]; then
  for t in "${!RESOLVED[@]}"; do echo "$t = ${RESOLVED[$t]}"; done
  exit 0
fi

# Rewrite. Each placeholder appears as ...@sha256:<TOKEN>; replace the whole
# @sha256:<TOKEN> with @<real-digest> (real digest already includes 'sha256:').
for f in "${FILES[@]}"; do
  changed=0
  for token in "${!RESOLVED[@]}"; do
    if grep -q "$token" "$f"; then
      sed -i "s|@sha256:${token}|@${RESOLVED[$token]}|g" "$f"
      # bare FROM/ARG forms without the @sha256: prefix (defensive)
      sed -i "s|${token}|${RESOLVED[$token]}|g" "$f"
      changed=1
    fi
  done
  [ "$changed" = 1 ] && echo "rewrote $f"
done

echo ""
echo "Done. Review the diff, then rebuild."
echo ""
echo "NOTE: nixpkgs pin (nixos/flake.nix PIN_ME_TO_A_COMMIT_SHA) is NOT resolved"
echo "here — pick an AUDITED nixpkgs commit by hand and set it, then \`nix flake"
echo "lock\`. That pin is a trust decision, not a registry lookup."
