#!/usr/bin/env sh
set -eu

REMOTE_NAME="${1:-origin}"
URL=$(git remote get-url "$REMOTE_NAME")

SANITIZED=$(printf '%s' "$URL" | sed -E 's#(https?://)[^/@]+@#\1#')

if [ "$SANITIZED" != "$URL" ]; then
  git remote set-url "$REMOTE_NAME" "$SANITIZED"
  echo "Sanitized remote '$REMOTE_NAME': $SANITIZED"
else
  echo "Remote '$REMOTE_NAME' already sanitized: $URL"
fi
