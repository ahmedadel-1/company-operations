#!/usr/bin/env bash
# Builds the four release images with one immutable tag (docs/runbooks/deploy.md):
#
#   bash scripts/release/build-images.sh <tag> [registry prefix, default ops]
#
# produces <prefix>/ops-api:<tag>, ops-worker, ops-web and ops-migrate from infra/docker/app.Dockerfile.
# Use a git SHA or semver as tag, never `latest`. Run from a clean checkout so the images match the
# reviewed source; pushing to the registry is a separate, explicit step.
set -euo pipefail

tag="${1:?usage: build-images.sh <tag> [registry prefix]}"
prefix="${2:-ops}"

if [ "$tag" = "latest" ]; then
  echo "build-images: use an immutable tag (git SHA or semver), not latest" >&2
  exit 1
fi

cd "$(dirname "$0")/../.."
for target in api worker web migrate; do
  echo "building ${prefix}/ops-${target}:${tag}"
  docker build --file infra/docker/app.Dockerfile --target "$target" --tag "${prefix}/ops-${target}:${tag}" .
done
docker image ls --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.Size}}' | grep -E "^${prefix}/ops-(api|worker|web|migrate):${tag} "
