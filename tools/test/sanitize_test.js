// Offline tests for the profile sanitizer: node tools/test/sanitize_test.js
'use strict';
const Module = require('module');
const path = require('path');
const assert = require('assert');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...a) { return req === 'webos-service' ? path.join(__dirname, 'fake-webos-service.js') : origResolve.call(this, req, ...a); };
const { sanitizeProfile, parseDetail, st } = require('../../service/com.homebrew.openvpn.service/service.js');

const CA = '<ca>\n-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n</ca>';
let n = 0;
function t(name, fn) { fn(); n++; console.log('ok', name); }

t('basic profile with auth', () => {
  const r = sanitizeProfile('client\ndev tun\nremote vpn.example.com 1194 udp\nauth-user-pass\n' + CA + '\n');
  assert.strictEqual(r.needsAuth, true);
  assert.strictEqual(r.remote, 'vpn.example.com:1194');
  assert.deepStrictEqual(r.removed, []);
});
t('dangerous directives removed', () => {
  const r = sanitizeProfile('client\nremote a 1\nscript-security 2\nup /bin/evil.sh\n--down "/bin/x"\nplugin /lib/x.so\nroute-up x\nmanagement 0.0.0.0 7505\nlog /etc/passwd\nconfig /tmp/other\n' + CA);
  for (const d of ['script-security', 'up', 'down', 'plugin', 'route-up', 'management', 'log', 'config']) assert(r.removed.includes(d), d);
  assert(!/^\s*(up|--down|plugin|script-security)\b/m.test(r.text));
});
t('case-insensitive and leading whitespace', () => {
  const r = sanitizeProfile('remote a 1\n   UP /bin/evil\n\tPlugin x\n');
  assert(r.removed.includes('UP') && r.removed.includes('Plugin'));
  const r2 = sanitizeProfile('remote a 1\nengine /tmp/x.so\nproviders evil\npkcs11-providers /tmp/p.so\ntls-export-cert /etc\n');
  assert.strictEqual(r2.removed.length, 4);
  assert(!/evil/.test(r.text));
});
t('auth-user-pass file argument dropped', () => {
  const r = sanitizeProfile('remote a 1\nauth-user-pass /etc/shadow\n');
  assert(r.removed.includes('auth-user-pass <file>'));
  assert(/^auth-user-pass$/m.test(r.text) && !/shadow/.test(r.text));
});
t('inline auth-user-pass means no prompt', () => {
  const r = sanitizeProfile('remote a 1\nauth-user-pass\n<auth-user-pass>\nu\np\n</auth-user-pass>\n');
  assert.strictEqual(r.needsAuth, false);
});
t('external cert file rejected', () => {
  assert.throws(() => sanitizeProfile('remote a 1\nca ca.crt\n'), /separate file/);
  assert.throws(() => sanitizeProfile('remote a 1\ntls-auth ta.key 1\n'), /separate file/);
});
t('unknown inline block dropped with contents', () => {
  const r = sanitizeProfile('remote a 1\n<foo>\nup /bin/evil\n</foo>\n');
  assert(r.removed.includes('<foo>'));
  assert(!/evil/.test(r.text));
});
t('directive text inside a cert block is untouched', () => {
  const r = sanitizeProfile('remote a 1\n<ca>\nup this is base64ish\n</ca>\n');
  assert.deepStrictEqual(r.removed, []);
  assert(/up this is base64ish/.test(r.text));
});
t('connection blocks are sanitized too', () => {
  const r = sanitizeProfile('<connection>\nremote a 1\nup /bin/evil\n</connection>\n');
  assert(r.removed.includes('up') && !/evil/.test(r.text));
});
t('missing remote rejected', () => { assert.throws(() => sanitizeProfile('client\ndev tun\n'), /remote/); });
t('empty / binary / huge rejected', () => {
  assert.throws(() => sanitizeProfile(''), /empty/);
  assert.throws(() => sanitizeProfile('remote a 1\n\0'), /text/);
  assert.throws(() => sanitizeProfile('remote a 1\n' + 'x'.repeat(600 * 1024)), /too big/);
});
t('CRLF and BOM', () => {
  const r = sanitizeProfile('﻿client\r\nremote a 1\r\nup /x\r\n');
  assert(r.removed.includes('up'));
});
t('user profile shape (pfSense export)', () => {
  const p = 'dev tun\npersist-tun\npersist-key\ndata-ciphers AES-256-GCM\nauth SHA256\ntls-client\nclient\nresolv-retry infinite\nremote 192.0.2.1 1194 udp4\nnobind\nauth-user-pass\nremote-cert-tls server\nexplicit-exit-notify\n' + CA + '\nsetenv CLIENT_CERT 0\nkey-direction 1\n<tls-auth>\n#\n-----BEGIN OpenVPN Static key V1-----\nab\n-----END OpenVPN Static key V1-----\n</tls-auth>\n';
  const r = sanitizeProfile(p);
  assert.strictEqual(r.needsAuth, true);
  assert.deepStrictEqual(r.removed, []);
  assert.strictEqual(r.remote, '192.0.2.1:1194');
});
t('connection details from a real openvpn 2.7 log', () => {
  [
    'OpenVPN 2.7.7 armv7-alpine-linux-musleabihf [SSL (OpenSSL)] [LZO] [LZ4] [EPOLL] [PKCS11] [MH/PKTINFO] [AEAD] [DCO]',
    'UDPv4 link local: (not bound)',
    'UDPv4 link remote: [AF_INET]192.0.2.10:1194',
    'VERIFY OK: depth=1, CN=TESTCA, C=PH, O=example',
    'VERIFY OK: depth=0, CN=vpn.example, C=PH, O=example',
    'Control Channel: TLSv1.3, cipher TLSv1.3 TLS_AES_256_GCM_SHA384, peer certificate: 2048 bits RSA, signature: RSA-SHA256, peer signing digest/type: rsa_pss_rsae_sha256 RSASSA-PSS, key agreement: X25519MLKEM768',
    "PUSH: Received control message: 'PUSH_REPLY,dhcp-option DOMAIN example.lan,dhcp-option DNS 1.1.1.1,dhcp-option DNS 8.8.4.4,register-dns,redirect-gateway def1,route-gateway 10.8.0.1,topology subnet,ping 10,ping-restart 60,ifconfig 10.8.0.9 255.255.255.0,peer-id 0,cipher AES-256-GCM,protocol-flags cc-exit tls-ekm dyn-tls-crypt,tun-mtu 1500,route 10.0.0.0 255.0.0.0'",
    'TUN/TAP device tun0 opened',
    "Data Channel: cipher 'AES-256-GCM', peer-id: 0",
    'Initialization Sequence Completed'
  ].forEach(parseDetail);
  const d = st.details;
  assert.strictEqual(d.openvpn, '2.7.7');
  assert.strictEqual(d.protocol, 'UDPv4'); assert.strictEqual(d.server, '192.0.2.10'); assert.strictEqual(d.port, '1194');
  assert(/CN=vpn.example/.test(d.serverCert)); assert(/CN=TESTCA/.test(d.serverCa));
  assert.strictEqual(d.tls, 'TLSv1.3'); assert.strictEqual(d.tlsCipher, 'TLS_AES_256_GCM_SHA384');
  assert.strictEqual(d.keyAgreement, 'X25519MLKEM768'); assert.strictEqual(d.peerKey, '2048 bits RSA');
  assert.deepStrictEqual(d.dns, ['1.1.1.1', '8.8.4.4']); assert.strictEqual(d.domain, 'example.lan');
  assert.strictEqual(d.redirect, 'def1'); assert.strictEqual(d.gateway, '10.8.0.1');
  assert.strictEqual(d.vpnIp, '10.8.0.9'); assert.strictEqual(d.netmask, '255.255.255.0');
  assert.deepStrictEqual(d.routes, ['10.0.0.0/8']); assert.strictEqual(d.mtu, '1500');
  assert.strictEqual(d.iface, 'tun0'); assert.strictEqual(d.dataCipher, 'AES-256-GCM'); assert.strictEqual(d.peerId, '0');
  assert.strictEqual(d.ping, '10'); assert.strictEqual(d.pingRestart, '60'); assert.strictEqual(d.completed, true);
});
// Regression tests for parser-differential bypasses found in review: whatever openvpn would read as an option must
// be what the sanitizer checked. The output is re-parsed and every option name must be allowed.
const { tokenize } = require('../../service/com.homebrew.openvpn.service/service.js');
function optionsOf(text) {
  const names = []; let inline = null;
  for (const raw of text.split('\n')) {
    const lead = raw.replace(/^\s+/, '');
    if (inline) { if (lead.startsWith('</' + inline + '>')) inline = null; continue; }
    const tk = tokenize(raw); if (!tk || !tk.length) continue;
    const m = /^<([a-z0-9-]+)>$/.exec(tk[0]); if (m) { if (m[1] !== 'connection') inline = m[1]; continue; }
    if (tk[0] === '</connection>') continue;
    names.push(tk[0].replace(/^--/, ''));
  }
  return names;
}
const BAD = ['up', 'down', 'plugin', 'script-security', 'management', 'log', 'config', 'cd', 'writepid', 'engine', 'providers', 'route-up', 'tls-verify'];
function clean(text) { const r = sanitizeProfile(text); const o = optionsOf(r.text); o.forEach((x) => assert(!BAD.includes(x), 'bad option survived: ' + x + '\n' + r.text)); return r; }
t('quoted option names', () => { clean('remote a 1\n"up" /bin/sh\n\'plugin\' /x.so\nu\\p /bin/sh\n"script-security" 2\n'); });
t('close tag with trailing text ends the block like openvpn does', () => {
  const r = clean('remote a 1\n<ca>\nAAA\n</ca> trailing\nup /bin/sh\n');
  assert(r.removed.includes('up'));
});
t('indented close tag', () => { clean('remote a 1\n<ca>\nAAA\n   </ca>\nup /bin/sh\n'); });
t('connection block ends at prefix', () => { clean('<connection>\nremote a 1\n</connection>junk\nup /bin/sh\n'); });
t('connection close inside inline is rejected', () => { assert.throws(() => sanitizeProfile('<connection>\nremote a 1\n<ca>\n</connection>\nup x\n</ca>\n</connection>\n')); });
t('quoted inline tag', () => { clean('remote a 1\n"<foo>"\nup /bin/sh\n</foo>\n'); });
t('unfinished block rejected', () => { assert.throws(() => sanitizeProfile('remote a 1\n<ca>\nAAA\n'), /unfinished/); });
t('comment after token', () => { const r = clean('remote a 1194 # my server\n'); assert.strictEqual(r.remote, 'a:1194'); });
t('CR-only line endings', () => { clean('remote a 1\rup /bin/sh\r'); });
t('unbalanced quote line dropped', () => { clean('remote a 1\nup "/bin/sh\n'); });
t('http-proxy credentials file dropped', () => { const r = clean('remote a 1\nhttp-proxy p 8080 /etc/shadow basic\n'); assert(!/shadow/.test(r.text)); });
t('auth-nocache removed (would break reconnects)', () => { const r = clean('remote a 1\nauth-user-pass\nauth-nocache\n'); assert(r.removed.includes('auth-nocache')); });
t('unknown options dropped', () => { const r = clean('remote a 1\nfoo-bar 1\n'); assert(r.removed.includes('foo-bar')); });
console.log(n + ' tests passed');
