# Third-party components

## Web app
- **qrcode-generator** 1.4.4 by Kazuhiko Arase, MIT (license header in `app/com.homebrew.openvpn/lib/qrcode.js`)

## OpenVPN (`service/com.homebrew.openvpn.service/bin`, built by `scripts/fetch_openvpn.py`, shipped in the IPK)
Unmodified binaries from official Alpine Linux packages, checked against the APKINDEX checksums. Each package's source,
build recipe and license is at https://gitlab.alpinelinux.org/alpine/aports (pick the matching branch); source tarballs are at
https://dl-cdn.alpinelinux.org/alpine/. OpenVPN is GPL-2.0 (https://github.com/OpenVPN/openvpn); OpenSSL is Apache-2.0;
musl is MIT; LZO is GPL-2.0; LZ4 is BSD-2-Clause; libcap-ng is LGPL-2.1; libnl3 is LGPL-2.1; pkcs11-helper is BSD/GPL.

OpenVPN is a registered trademark of OpenVPN Inc. This project is not affiliated with or endorsed by OpenVPN Inc.

```
Bundled from Alpine Linux v3.24 (armv7). Sources: https://gitlab.alpinelinux.org/alpine/aports

musl 1.2.6-r3 (main)
openvpn 2.7.7-r0 (main)
iproute2-minimal 7.0.0-r0 (main)
libcap-ng 0.8.5-r2 (main)
libcrypto3 3.5.9-r1 (main)
lz4-libs 1.10.0-r1 (main)
lzo 2.10-r5 (main)
libnl3 3.11.0-r0 (main)
pkcs11-helper 1.31.0-r0 (main)
libssl3 3.5.9-r1 (main)
libcap2 2.78-r0 (main)
libelf 0.195-r0 (main)
libmnl 1.0.5-r2 (main)
zlib 1.4-r0 (main)
zstd-libs 1.5.7-r2 (main)
```
