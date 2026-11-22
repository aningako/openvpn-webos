#!/bin/sh
# Dev helper: build, copy and install the IPK on a rooted TV over SSH, then re-elevate the service.
# Usage: TV=192.168.x.y scripts/install_tv.sh
set -e
cd "$(dirname "$0")/.."
: "${TV:?set TV=<tv ip>}"
python3 scripts/build_ipk.py
IPK=$(ls -t releases/*.ipk | head -1)
scp -q "$IPK" root@"$TV":/tmp/ovpn.ipk
ssh -q -tt root@"$TV" '
luna-send -w 90000 -i luna://com.webos.appInstallService/dev/install "{\"id\":\"com.homebrew.openvpn\",\"ipkUrl\":\"/tmp/ovpn.ipk\",\"subscribe\":true}" > /tmp/ovpn-inst.log 2>&1 &
for i in $(seq 1 60); do grep -q "\"installed\"\|FAILED\|failed" /tmp/ovpn-inst.log && break; sleep 1; done
kill %1 2>/dev/null; grep -o "\"state\":\"[^\"]*\"" /tmp/ovpn-inst.log | tail -1
/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service com.homebrew.openvpn.service >/dev/null 2>&1
luna-send -n 1 luna://com.homebrew.openvpn.service/quit "{}" >/dev/null; sleep 2
luna-send -n 1 luna://com.homebrew.openvpn.service/getInfo "{}"; rm -f /tmp/ovpn.ipk /tmp/ovpn-inst.log' | tr -d '\r'
