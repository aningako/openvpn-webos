#!/bin/sh
# OpenVPN for webOS - keep-connected watchdog (runs as root).
# Started by the service when a VPN connects, and at boot by the app's Homebrew Channel boot hook
# (/var/lib/webosbrew/init.d/60-openvpn-webos). Every 20 s: if "keep connected" is on, the user did not press
# Disconnect and openvpn is not running, ask the service to reconnect the selected profile with its saved login.
# Cleans up after itself: exits when Keep connected is turned off, hands over to a newer watchdog after an app update,
# and if the app was uninstalled it stops the VPN and removes the boot hook.
D=/home/root/.config/com.homebrew.openvpn
R=$D/run
SVC=luna://com.homebrew.openvpn.service/autoConnect
SELF=$(readlink -f "$0")
SVCDIR=$(dirname "$SELF")
BIN="$SVCDIR/bin/libexec/openvpn"
BOOT=/var/lib/webosbrew/init.d/60-openvpn-webos
ELEVATE=/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service
API=luna://com.homebrew.openvpn.service

# Installing or updating the app (e.g. from Homebrew Channel) registers the service without root again. The app fixes
# that when it is opened; the watchdog does it too, so a reboot right after an update still reconnects.
ensure_root() {
    luna-send -n 1 -w 8000 "$API/getInfo" '{}' 2>/dev/null | grep -q '"root":true' && return 0
    [ -x "$ELEVATE" ] || return 1
    "$ELEVATE" com.homebrew.openvpn.service >/dev/null 2>&1
    luna-send -n 1 -w 5000 "$API/quit" '{}' >/dev/null 2>&1
    sleep 2
}

# is_ours <pidfile> <text>: the pid in the file is alive AND its command line contains <text> (pids get reused)
is_ours() {
    p=$(cat "$1" 2>/dev/null)
    [ -n "$p" ] && [ -r "/proc/$p/cmdline" ] && tr '\0' ' ' < "/proc/$p/cmdline" | grep -qF "$2"
}
inode() { ls -id "$1" 2>/dev/null | awk '{print $1}'; }

# The app was uninstalled (checked twice, a minute apart, so an update that replaces the files doesn't count):
# stop the VPN it left running and remove the boot hook. Profiles and saved logins stay in $D.
app_gone() {
    [ -f "$BIN" ] && return 1
    sleep 60
    [ -f "$BIN" ] && return 1
    is_ours "$R/openvpn.pid" "$BIN" && kill "$(cat "$R/openvpn.pid")"
    rm -f "$BOOT" "$D/keep-connected" "$R/openvpn.pid" "$R/current.json" "$R/mgmt.sock"
    return 0
}

if [ "$1" != "run" ]; then
    # detach so the boot hook / the service never wait for us
    [ -f "$D/keep-connected" ] || exit 0
    mkdir -p "$R" && chmod 700 "$R"
    is_ours "$R/watchdog.pid" "watchdog.sh run" && exit 0
    nohup /bin/sh "$SELF" run "$1" >/dev/null 2>&1 </dev/null &
    exit 0
fi

is_ours "$R/watchdog.pid" "watchdog.sh run" && [ "$(cat "$R/watchdog.pid")" != "$$" ] && exit 0
echo $$ > "$R/watchdog.pid"
MYINODE=$(inode "$SELF")
if [ "$2" = "now" ]; then sleep 20; else sleep 15; fi     # at boot: give the network a moment
while [ -f "$D/keep-connected" ]; do
    app_gone && break
    # an app update replaced this script: continue with the new version (same pid, so no second watchdog)
    if [ -f "$SELF" ] && [ "$(inode "$SELF")" != "$MYINODE" ]; then exec /bin/sh "$SELF" run now; fi
    if [ ! -f "$D/user-stopped" ] && ! is_ours "$R/openvpn.pid" "$BIN"; then
        if ip route | grep -q '^default'; then
            ensure_root
            luna-send -n 1 -w 90000 "$SVC" '{}' >/dev/null 2>&1
        fi
    fi
    sleep 20
done
rm -f "$R/watchdog.pid"
