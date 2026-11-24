#!/bin/bash
# Signs Trellis.app with the project's own code-signing certificate, so every build carries the same signature and
# the Keychain keeps its "Always Allow" across updates (an ad-hoc signature changes with every build, and macOS then
# asks for the login password again).
#   scripts/sign-macos.sh path/to/Trellis.app <keychain> [keychain password]
# The certificate is self-signed ("Trellis Code Signing"): it makes the signature stable, not Apple-approved, so
# Gatekeeper still treats the app as from an unidentified developer.
set -euo pipefail
APP=$1
KC=$2
[ -n "${3:-}" ] && security unlock-keychain -p "$3" "$KC"
# codesign finds an identity only in a keychain on the search list, whatever --keychain says: add ours for the
# signing and put the list back afterwards.
LIST=$(security list-keychains -d user | tr -d '"' | xargs)
case " $LIST " in *" $KC "*) ;; *) security list-keychains -d user -s $LIST "$KC"; trap 'security list-keychains -d user -s $LIST' EXIT ;; esac
codesign --force --deep --timestamp=none --keychain "$KC" -s "Trellis Code Signing" "$APP"
codesign --verify --deep --strict "$APP" 2>/dev/null || true
codesign -d -r- "$APP" 2>&1 | grep designated
