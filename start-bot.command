#!/bin/sh
cd "$(dirname "$0")"
while true; do
  npm run build || exit 1
  npm start
  EXIT_CODE=$?
  if [ "$EXIT_CODE" -eq 75 ]; then
    echo "Restarting after update..."
    continue
  fi
  break
done
