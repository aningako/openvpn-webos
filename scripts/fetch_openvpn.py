#!/usr/bin/env python3
"""Fetch OpenVPN for the TV from official Alpine Linux armv7 packages.

Every package is checked against the checksum in Alpine's APKINDEX (downloaded over HTTPS) before use.
Output: service/com.homebrew.openvpn.service/bin/
    openvpn            wrapper script (runs the real binary through the bundled musl loader)
    libexec/openvpn    the real binary
    lib/               musl loader + shared libraries

Usage: python3 scripts/fetch_tools.py [--branch v3.24]
"""
import base64, hashlib, io, os, re, shutil, subprocess, sys, tarfile, urllib.request, zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'service', 'com.homebrew.openvpn.service', 'bin')
CACHE = os.path.join(ROOT, 'build', 'apk-cache')
ARCH = 'armv7'
LOADER = 'ld-musl-armhf.so.1'
BRANCH = sys.argv[sys.argv.index('--branch') + 1] if '--branch' in sys.argv else 'v3.24'
MIRROR = 'https://dl-cdn.alpinelinux.org/alpine/%s/%%s/%s/' % (BRANCH, ARCH)
WANT = ['musl', 'openvpn']
# Things the packages "depend on" that we don't need inside a self-contained tools dir.
SKIP = {'busybox', 'busybox-binsh', 'alpine-baselayout', 'alpine-baselayout-data', 'apk-tools', 'ca-certificates',
        'musl-utils', 'scanelf', 'libc-utils', 'openrc', 'iproute2'}
BINARIES = {'openvpn': ('usr/sbin/openvpn', [])}


def fetch(url, dest):
    if not os.path.exists(dest):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with urllib.request.urlopen(url, timeout=60) as r, open(dest + '.part', 'wb') as f:
            shutil.copyfileobj(r, f)
        os.replace(dest + '.part', dest)
    return open(dest, 'rb').read()


def gzip_members(data):
    """Split concatenated gzip streams; return list of raw member byte strings."""
    out, pos = [], 0
    while pos < len(data):
        d = zlib.decompressobj(31)
        d.decompress(data[pos:])
        end = len(data) - len(d.unused_data)
        out.append(data[pos:end])
        pos = end
    return out


def load_index():
    pkgs = {}
    for repo in ('main', 'community'):
        raw = fetch(MIRROR % repo + 'APKINDEX.tar.gz', os.path.join(CACHE, BRANCH, repo, 'APKINDEX.tar.gz'))
        tf = tarfile.open(fileobj=io.BytesIO(raw))
        text = tf.extractfile('APKINDEX').read().decode()
        for block in text.strip().split('\n\n'):
            e = {'repo': repo, 'deps': [], 'provides': []}
            for line in block.splitlines():
                k, _, v = line.partition(':')
                if k == 'P': e['name'] = v
                elif k == 'V': e['ver'] = v
                elif k == 'C': e['csum'] = v
                elif k == 'D': e['deps'] = v.split()
                elif k == 'p': e['provides'] = v.split()
            if 'name' in e:
                pkgs.setdefault(e['name'], e)
    provides = {}
    for e in pkgs.values():
        provides.setdefault(e['name'], e['name'])
        for p in e['provides']:
            provides.setdefault(p.split('=')[0], e['name'])
    return pkgs, provides


def resolve(pkgs, provides):
    todo, seen = list(WANT), []
    while todo:
        n = todo.pop(0)
        if n in seen or n in SKIP:
            continue
        seen.append(n)
        for d in pkgs[n]['deps']:
            if d.startswith('!'):
                continue
            for op in ('>=', '<=', '=', '>', '<', '~'):
                d = d.split(op)[0]
            name = provides.get(d)
            if name is None:
                raise SystemExit('cannot resolve dependency %s of %s' % (d, n))
            todo.append(name)
    return seen


def extract(pkg, rootfs):
    fn = '%s-%s.apk' % (pkg['name'], pkg['ver'])
    data = fetch(MIRROR % pkg['repo'] + fn, os.path.join(CACHE, BRANCH, pkg['repo'], fn))
    members = gzip_members(data)
    control, payload = (members[1], members[2]) if len(members) >= 3 else (members[0], members[1])
    got = 'Q1' + base64.b64encode(hashlib.sha1(control).digest()).decode()
    if got != pkg['csum']:
        raise SystemExit('CHECKSUM MISMATCH for %s: %s != %s' % (fn, got, pkg['csum']))
    tf = tarfile.open(fileobj=io.BytesIO(zlib.decompress(payload, 31)))
    for m in tf.getmembers():
        if m.name.startswith('.') or '..' in m.name.split('/'):
            continue
        dest = os.path.join(rootfs, m.name)
        if m.isdir():
            os.makedirs(dest, exist_ok=True)
        elif m.issym():
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            if os.path.lexists(dest): os.remove(dest)
            os.symlink(m.linkname, dest)
        elif m.isfile():
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, 'wb') as f:
                f.write(tf.extractfile(m).read())
            os.chmod(dest, 0o755 if m.mode & 0o111 else 0o644)
    return fn


def copy_real(src, dst, mode=0o644):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(os.path.realpath(src), dst)
    os.chmod(dst, mode)


def copy_tree(src, dst, drop=()):
    for dp, dns, fns in os.walk(src):
        dns[:] = sorted(x for x in dns if not (dp == src and x in drop))
        for fn in fns:
            s = os.path.join(dp, fn)
            if not os.path.exists(s):
                continue  # dangling symlink
            copy_real(s, os.path.join(dst, os.path.relpath(s, src)))


WRAPPER = '''#!/bin/sh
# OpenVPN for webOS: run the bundled openvpn through the bundled musl loader.
B=$(cd "$(dirname "$0")" && pwd)
unset LD_PRELOAD LD_LIBRARY_PATH   # the TV's glibc libraries must not leak into the musl binary
exec "$B/lib/%(loader)s" --library-path "$B/lib" --argv0 openvpn "$B/libexec/openvpn" "$@"
'''


def main():
    pkgs, provides = load_index()
    names = resolve(pkgs, provides)
    rootfs = os.path.join(ROOT, 'build', 'rootfs-' + ARCH)
    shutil.rmtree(rootfs, ignore_errors=True)
    for n in names:
        print('  %-28s %s' % (n, extract(pkgs[n], rootfs)))
    shutil.rmtree(OUT, ignore_errors=True)
    for d in ('libexec', 'lib'):
        os.makedirs(os.path.join(OUT, d), exist_ok=True)
    copy_real(os.path.join(rootfs, 'lib', LOADER), os.path.join(OUT, 'lib', LOADER), 0o755)
    todo = [os.path.join(rootfs, p) for p, _ in BINARIES.values()]
    done = set()
    while todo:
        elf = todo.pop()
        out = subprocess.run(['readelf', '-d', elf], capture_output=True, text=True, check=True).stdout
        for so in re.findall(r'\(NEEDED\)\s+Shared library: \[([^\]]+)\]', out):
            if so in done or so.startswith('libc.musl'):
                continue
            done.add(so)
            src = next((os.path.join(rootfs, d, so) for d in ('lib', 'usr/lib') if os.path.exists(os.path.join(rootfs, d, so))), None)
            if not src:
                raise SystemExit('missing library ' + so)
            copy_real(src, os.path.join(OUT, 'lib', so))
            todo.append(src)
    print('  libraries:', ' '.join(sorted(done)))
    copy_real(os.path.join(rootfs, 'usr/sbin/openvpn'), os.path.join(OUT, 'libexec', 'openvpn'), 0o755)
    open(os.path.join(OUT, 'openvpn'), 'w').write(WRAPPER % {'loader': LOADER})
    os.chmod(os.path.join(OUT, 'openvpn'), 0o755)
    with open(os.path.join(OUT, 'PACKAGES.txt'), 'w') as f:
        f.write('Bundled from Alpine Linux %s (%s). Sources: https://gitlab.alpinelinux.org/alpine/aports\n\n' % (BRANCH, ARCH))
        for n in names:
            f.write('%s %s (%s)\n' % (n, pkgs[n]['ver'], pkgs[n]['repo']))
    total = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(OUT) for f in fs)
    print('openvpn written to %s (%.1f MB)' % (OUT, total / 1e6))


if __name__ == '__main__':
    main()
