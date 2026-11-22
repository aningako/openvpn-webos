# Changelog

## 1.0.2 - 2026-11-22
Boot script cleanup.
- The boot hook in `/var/lib/webosbrew/init.d` is now a small standalone script instead of a symlink into the app. It
  removes itself if the app is no longer installed, so an uninstall no longer leaves a dangling entry that fails at
  every boot. Existing symlinks from 1.0.0/1.0.1 are replaced automatically.
- Uninstalling while connected: the watchdog now stops the VPN and removes the boot hook (before, the VPN stayed up
  until the next reboot).
- After an app update the running watchdog switches to the new version instead of running the old one until reboot.
- No boot hook at all until you connect with Keep connected on; turning Keep connected off removes it.

## 1.0.1 - 2026-11-22
- Keep connected after an update: installing/updating the app re-registers its service without root; the watchdog now
  restores root itself, so a TV restart right after an update still reconnects (before, it waited until the app was
  opened).

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
