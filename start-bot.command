#!/bin/sh
cd "$(dirname "$0")"
npm run build || exit 1
npm start
