# Changelog

## 1.0.0 - 2026-11-22
First release.
- OpenVPN 2.7 client for rooted LG webOS TVs (root service elevated through Homebrew Channel).
- Import your own .ovpn profile from a phone/PC (LAN upload page with QR code and 6-digit code) or from a USB stick.
  Scripts and plugins in profiles are removed, and openvpn always runs with `--script-security 1`.
- Login prompt on the TV or on the upload page; "Remember on this TV" saves it only after the server accepted it.
- Stays connected: the VPN runs on its own, Back does not exit while connected, a watchdog reconnects after drops and
  after the TV restarts ("Keep connected").
- "Local network access": home devices on other subnets can still reach the TV while the VPN takes all traffic.
- Connection details: server, protocol, certificate, TLS version/cipher, key exchange, data cipher, interface, VPN
  address/gateway, routing, MTU, keepalive, pushed DNS, live speed, traffic, public IP, reconnects; plus the OpenVPN log.
- Built-in Help screen.
