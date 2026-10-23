#!/bin/sh
exec pwsh -NoProfile -File "$(dirname "$0")/scripts/deploy-private.ps1" "$@"
