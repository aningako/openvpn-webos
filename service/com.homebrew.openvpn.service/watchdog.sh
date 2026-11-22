#!/bin/sh
# OpenVPN for webOS - keep-connected watchdog (runs as root).
# Started by the service when a VPN connects, and at boot by Homebrew Channel (/var/lib/webosbrew/init.d).
# Every 20 s: if "keep connected" is on, the user did not press Disconnect and openvpn is not running,
# ask the service to reconnect the selected profile with its saved credentials.
D=/home/root/.config/com.homebrew.openvpn
R=$D/run
SVC=luna://com.homebrew.openvpn.service/autoConnect
SELF=$(readlink -f "$0")
BIN="$(dirname "$SELF")/bin/libexec/openvpn"

# is_ours <pidfile> <text>: the pid in the file is alive AND its command line contains <text> (pids get reused)
is_ours() {
    p=$(cat "$1" 2>/dev/null)
    [ -n "$p" ] && [ -r "/proc/$p/cmdline" ] && tr '\0' ' ' < "/proc/$p/cmdline" | grep -qF "$2"
}

if [ "$1" != "run" ]; then
    # detach so init.d / the service never wait for us
    [ -f "$D/keep-connected" ] || exit 0
    mkdir -p "$R" && chmod 700 "$R"
    is_ours "$R/watchdog.pid" "watchdog.sh run" && exit 0
    nohup /bin/sh "$SELF" run "$1" >/dev/null 2>&1 </dev/null &
    exit 0
fi

is_ours "$R/watchdog.pid" "watchdog.sh run" && [ "$(cat "$R/watchdog.pid")" != "$$" ] && exit 0
echo $$ > "$R/watchdog.pid"
if [ "$2" = "now" ]; then sleep 20; else sleep 15; fi     # at boot: give the network a moment
while [ -f "$D/keep-connected" ]; do
    if [ ! -f "$D/user-stopped" ] && ! is_ours "$R/openvpn.pid" "$BIN"; then
        if ip route | grep -q '^default'; then
            luna-send -n 1 -w 90000 "$SVC" '{}' >/dev/null 2>&1
        fi
    fi
    sleep 20
done
rm -f "$R/watchdog.pid"
