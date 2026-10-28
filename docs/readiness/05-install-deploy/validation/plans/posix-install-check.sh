#!/bin/sh
# 05 INS clean-VM checks for macOS and Ubuntu (validation/README.md). Runs INSIDE a disposable VM snapshot.
# Usage: posix-install-check.sh <mac|deb|appimage> <vm-profile> <artifact>
#   mac       artifact = llull-<v>.dmg      (VC-INS-03, 13, 27)
#   deb       artifact = llull_<v>_amd64.deb (VC-INS-04, 27)   needs sudo for apt only
#   appimage  artifact = llull-<v>.AppImage (VC-INS-30)
# Writes <vm-profile>-<scenario>.result.json next to this script; exit 0 when every assertion holds.
# Doctor steps print "skip: doctor not built" until M1 ships `llull --doctor --json`.
set -u
SCENARIO="$1"; PROFILE="$2"; ARTIFACT="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"
RESULT="$HERE/$PROFILE-$SCENARIO.result.json"
FAILED=0
CHECKS=""

check() { # case name ok(0|1) detail
  ok=$([ "$3" -eq 0 ] && echo true || echo false)
  [ "$3" -eq 0 ] || case "$4" in skip:*) ;; *) FAILED=1 ;; esac
  detail=$(printf '%s' "$4" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
  CHECKS="$CHECKS{\"case\":\"$1\",\"name\":\"$2\",\"ok\":$ok,\"detail\":\"$detail\"},"
}

doctor() { # case binary
  out=$("$2" --doctor --json 2>/dev/null); code=$?
  if [ -z "$out" ]; then check "$1" doctor 1 "skip: doctor not built (exit $code)"; return; fi
  check "$1" "doctor exit 0" "$code" "exit $code"
  printf '%s' "$out" | grep -q '"status": *"occt"'; check "$1" "kernel occt" $? "$(printf '%s' "$out" | grep -o '"occtVersion": *"[^"]*"')"
  printf '%s' "$out" | grep -q '"id": *"step"[^}]*"status": *"pass"'; check "VC-INS-27" "STEP round trip" $? "doctor step check"
}

case "$SCENARIO" in
  mac)
    MNT=$(hdiutil attach -nobrowse -readonly "$ARTIFACT" | awk '/\/Volumes\//{print substr($0, index($0,"/Volumes/"))}')
    xcrun stapler validate "$ARTIFACT" >/dev/null 2>&1; check VC-INS-13 "dmg stapled" $? "$ARTIFACT"
    cp -R "$MNT/llull.app" "$HOME/Applications/" && hdiutil detach "$MNT" >/dev/null
    APP="$HOME/Applications/llull.app"
    codesign --verify --deep --strict "$APP" 2>/dev/null; check VC-INS-13 "codesign strict" $? "$APP"
    spctl --assess --type execute "$APP" 2>/dev/null; check VC-INS-03 "Gatekeeper accepts (offline)" $? "spctl"
    xcrun stapler validate "$APP" >/dev/null 2>&1; check VC-INS-13 "app stapled" $? "$APP"
    unsigned=0
    for f in $(find "$APP" -type f -perm -u+x -o -type f -name '*.dylib' -o -type f -name '*.so'); do
      if file "$f" | grep -q 'Mach-O'; then
        codesign -dv "$f" 2>&1 | grep -q 'Authority=Developer ID Application' || { unsigned=$((unsigned + 1)); echo "unsigned: $f" >&2; }
      fi
    done
    [ "$unsigned" -eq 0 ]; check VC-INS-13 "unsigned Mach-O = 0" $? "$unsigned unsigned"
    codesign -d --entitlements :- "$APP" 2>/dev/null > "$HERE/$PROFILE-entitlements.plist"
    check VC-INS-13 "entitlements recorded for review" 0 "$PROFILE-entitlements.plist"
    doctor VC-INS-03 "$APP/Contents/MacOS/llull"
    ;;
  deb)
    sudo apt-get install -y --no-download "./$(basename "$ARTIFACT")" >/dev/null 2>&1 || sudo dpkg -i "$ARTIFACT" >/dev/null 2>&1
    dpkg -s llull >/dev/null 2>&1; check VC-INS-04 "deb installed offline" $? "$ARTIFACT"
    [ -f /etc/apparmor.d/llull ]; check VC-INS-04 "AppArmor profile installed" $? "/etc/apparmor.d/llull"
    BIN=$(command -v llull-desktop || echo /opt/llull/llull)
    timeout 60 "$BIN" --enable-logging 2>"$HERE/$PROFILE-launch.log" & PID=$!
    sleep 20
    kill -0 "$PID" 2>/dev/null; check VC-INS-04 "window process alive with sandbox" $? "pid $PID"
    ! grep -qi 'no-sandbox\|sandbox.*fatal\|SIGTRAP' "$HERE/$PROFILE-launch.log"; check VC-INS-04 "no sandbox error" $? "launch log"
    kill "$PID" 2>/dev/null
    doctor VC-INS-04 "$BIN"
    ;;
  appimage)
    chmod +x "$ARTIFACT"
    timeout 60 "$ARTIFACT" 2>"$HERE/$PROFILE-appimage.log" & PID=$!
    sleep 20
    kill -0 "$PID" 2>/dev/null; check VC-INS-30 "AppImage running" $? "$(head -c 400 "$HERE/$PROFILE-appimage.log")"
    kill "$PID" 2>/dev/null
    ;;
  *) echo "unknown scenario $SCENARIO" >&2; exit 2 ;;
esac

printf '{"profile":"%s","mode":"%s","checks":[%s]}\n' "$PROFILE" "$SCENARIO" "${CHECKS%,}" > "$RESULT"
exit "$FAILED"
