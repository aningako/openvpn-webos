/*
 * OpenVPN for webOS - root service (elevated by Homebrew Channel).
 * Created by aning with Claude.
 *
 * Runs the bundled openvpn binary detached (the VPN stays up when the app is closed and this service exits)
 * and talks to it over its management socket. Credentials are handed to openvpn over that socket, so they are
 * never written to disk unless the user ticks "Remember".
 *
 * Profiles are imported by the user (LAN upload page or USB stick) and sanitized: anything that would let a
 * profile run programs as root (up/down scripts, plugins, ...) is removed, and openvpn always gets
 * --script-security 1 on its command line.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Service = require('webos-service');
const pkg = require('./package.json');

const service = new Service(pkg.name);
const BIN = path.join(__dirname, 'bin', 'openvpn');
const DATA = '/home/root/.config/com.homebrew.openvpn';
const PROFILES = DATA + '/profiles';
const CREDS = DATA + '/creds';
const SETTINGS = DATA + '/settings.json';
const RUN = DATA + '/run';                      // root-only (not world-writable /tmp)
const SOCK = RUN + '/mgmt.sock';
const LOGFILE = RUN + '/openvpn.log';
const PIDFILE = RUN + '/openvpn.pid';
const CURRENT = RUN + '/current.json';
const KEEP_FLAG = DATA + '/keep-connected';   // read by watchdog.sh: reconnect when openvpn is not running
const STOP_FLAG = DATA + '/user-stopped';     // the user pressed Disconnect (or the password was wrong): don't reconnect
const WATCHDOG = path.join(__dirname, 'watchdog.sh');
const INITD = '/var/lib/webosbrew/init.d/60-openvpn-webos';
const UPLOAD_PORT = 8899;
const MAX_PROFILE = 512 * 1024;
const USB_ROOTS = ['/tmp/usb', '/mnt/usb', '/media/usb'];

// ------------------------------------------------------------------ helpers
function ok(msg, extra) { msg.respond(Object.assign({ returnValue: true }, extra || {})); }
function fail(msg, text, extra) { msg.respond(Object.assign({ returnValue: false, errorText: String(text) }, extra || {})); }
function isRoot() { return process.getuid && process.getuid() === 0; }
function ensureDirs() {
  for (const d of [DATA, PROFILES, CREDS, RUN]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    const stt = fs.lstatSync(d);
    if (!stt.isDirectory() || stt.uid !== 0) throw new Error('Unsafe data folder ' + d);
    fs.chmodSync(d, 0o700);
  }
}
function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dflt; } }
function writeJson(p, v, mode) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v), { mode: mode || 0o600 });
  fs.renameSync(tmp, p);
}
function validId(id) { return typeof id === 'string' && /^[a-f0-9]{16}$/.test(id); }

function lanAccess() { return readJson(SETTINGS, {}).lanAccess !== false; }       // on by default
function keepConnected() { return readJson(SETTINGS, {}).keepConnected !== false; }   // on by default
function touch(p) { try { fs.writeFileSync(p, '', { mode: 0o600 }); } catch (e) { /* ignore */ } }
function rm(p) { try { fs.unlinkSync(p); } catch (e) { /* none */ } }
// Boot hook for Homebrew Channel (it runs /var/lib/webosbrew/init.d/* at boot). A small standalone script rather than a
// symlink into the app: if the app has been uninstalled it deletes itself instead of leaving a dangling entry behind.
const BOOT_SCRIPT = `#!/bin/sh
# OpenVPN for webOS: starts the keep-connected watchdog at boot. Written by the app (Keep connected = on).
# Removes itself when the app is no longer installed.
W=${WATCHDOG}
if [ -f "$W" ]; then
    exec /bin/sh "$W" boot
fi
rm -f "$0"
`;
function applyKeepConnected() {
  if (keepConnected()) {
    touch(KEEP_FLAG);
    try {
      fs.mkdirSync(path.dirname(INITD), { recursive: true });
      let cur = null;
      try { if (!fs.lstatSync(INITD).isSymbolicLink()) cur = fs.readFileSync(INITD, 'utf8'); } catch (e) { /* missing */ }
      if (cur !== BOOT_SCRIPT) {           // also replaces the symlink that 1.0.0/1.0.1 created
        rm(INITD);
        fs.writeFileSync(INITD + '.tmp', BOOT_SCRIPT, { mode: 0o755 });
        fs.renameSync(INITD + '.tmp', INITD);
      }
    } catch (e) { console.error('boot script: ' + e.message); }
  } else { rm(KEEP_FLAG); rm(INITD); }
}
function startWatchdog() {
  if (!keepConnected()) return;
  try { spawn('/bin/sh', [WATCHDOG, 'now'], { detached: true, stdio: 'ignore' }).unref(); } catch (e) { console.error('watchdog: ' + e.message); }
}

// ------------------------------------------------------------------ profile sanitizer
// openvpn runs as root, so a profile is rebuilt from scratch: each line is split into tokens the way openvpn's own
// parser does it (options.c parse_line), only known client options are kept, and the line is written back from the
// tokens. Anything that could run a program, load code, read/write a file, or change the management setup is dropped.
const ALLOW = new Set(['client', 'tls-client', 'pull', 'dev', 'dev-type', 'proto', 'proto-force', 'remote', 'remote-random',
  'remote-random-hostname', 'port', 'rport', 'lport', 'local', 'bind', 'nobind', 'float', 'resolv-retry', 'connect-retry',
  'connect-retry-max', 'connect-timeout', 'server-poll-timeout', 'explicit-exit-notify', 'persist-tun', 'persist-key',
  'persist-remote-ip', 'persist-local-ip', 'ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'tls-crypt-v2', 'extra-certs',
  'pkcs12', 'dh', 'crl-verify', 'secret', 'key-direction', 'key-method', 'remote-cert-tls', 'remote-cert-ku', 'remote-cert-eku',
  'verify-x509-name', 'ns-cert-type', 'tls-remote', 'verify-hash', 'peer-fingerprint', 'tls-version-min', 'tls-version-max',
  'tls-cipher', 'tls-ciphersuites', 'tls-groups', 'tls-cert-profile', 'ecdh-curve', 'cipher', 'data-ciphers',
  'data-ciphers-fallback', 'ncp-ciphers', 'ncp-disable', 'auth', 'keysize', 'auth-user-pass', 'askpass', 'auth-token',
  'auth-token-user', 'static-challenge', 'auth-retry', 'comp-lzo', 'compress', 'allow-compression', 'mssfix', 'fragment',
  'tun-mtu', 'tun-mtu-extra', 'tun-mtu-max', 'link-mtu', 'mtu-disc', 'mtu-test', 'sndbuf', 'rcvbuf', 'txqueuelen',
  'keepalive', 'ping', 'ping-restart', 'ping-exit', 'ping-timer-rem', 'inactive', 'reneg-sec', 'reneg-bytes', 'reneg-pkts',
  'hand-window', 'tran-window', 'tls-timeout', 'tls-exit', 'replay-window', 'mute-replay-warnings', 'no-replay', 'route',
  'route-ipv6', 'route-gateway', 'route-metric', 'route-delay', 'max-routes', 'redirect-gateway', 'redirect-private',
  'route-nopull', 'pull-filter', 'ignore-unknown-option', 'setenv', 'setenv-safe', 'dhcp-option', 'dns', 'block-ipv6',
  'ifconfig', 'ifconfig-ipv6', 'topology', 'tun-ipv6', 'verb', 'mute', 'http-proxy', 'http-proxy-option', 'http-proxy-retry',
  'http-proxy-user-pass', 'socks-proxy', 'socks-proxy-retry', 'passtos', 'fast-io', 'mark', 'bind-dev', 'allow-pull-fqdn',
  'client-nat', 'ip-win32', 'register-dns', 'block-outside-dns', 'windows-driver', 'dhcp-renew', 'dhcp-release',
  'disable-dco', 'up-delay', 'up-restart', 'push-peer-info', 'opt-verify', 'compat-mode', 'session-timeout',
  'force-tls-key-material-export', 'suppress-timestamps', 'echo', 'remap-usr1', 'single-session', 'prng']);
// Options whose argument is a file: only inline data (<tag>...</tag>) is accepted.
const FILE_ARGS = new Set(['ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'tls-crypt-v2', 'pkcs12', 'extra-certs',
  'dh', 'crl-verify', 'secret', 'http-proxy-user-pass']);
const INLINE = new Set(['ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'tls-crypt-v2', 'pkcs12', 'extra-certs',
  'dh', 'crl-verify', 'secret', 'http-proxy-user-pass', 'auth-user-pass', 'peer-fingerprint']);

// Same rules as openvpn's parse_line(): whitespace separates tokens, "..." groups with backslash escapes, '...' groups
// literally, a backslash outside quotes escapes the next character, and # or ; at the start of a token ends the line.
function tokenize(line) {
  const tokens = [];
  let cur = null, quote = null, i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") { if (c === "'") quote = null; else cur += c; continue; }
    if (c === '\\' && quote !== "'") {
      if (i + 1 >= line.length) return null;
      if (cur === null) cur = '';
      cur += line[++i];
      continue;
    }
    if (quote === '"') { if (c === '"') quote = null; else cur += c; continue; }
    if (c === '"' || c === "'") { if (cur === null) cur = ''; quote = c; continue; }
    if (/\s/.test(c)) { if (cur !== null) { tokens.push(cur); cur = null; } continue; }
    if (cur === null && (c === '#' || c === ';')) break;
    cur = (cur === null ? '' : cur) + c;
  }
  if (quote) return null;            // openvpn: "No closing quotation"
  if (cur !== null) tokens.push(cur);
  return tokens;
}
function quoteToken(t) {
  return /^[A-Za-z0-9_.:/@+=,[\]-]+$/.test(t) ? t : '"' + t.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function sanitizeProfile(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('The file is empty.');
  if (text.length > MAX_PROFILE) throw new Error('The file is too big for an OpenVPN profile.');
  if (/[\0\x01-\x08\x0e-\x1f]/.test(text.replace(/\x1b/g, ''))) throw new Error('This is not a text file.');
  const out = [], removed = [];
  let inline = null, dropBlock = false, inConn = false;
  let hasRemote = false, needsAuth = false, inlineAuth = false, remote = '';
  const drop = (what) => { if (removed.indexOf(what) < 0) removed.push(what); };
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n|\r/)) {
    const lead = raw.replace(/^\s+/, '');
    // openvpn reads a <connection> block as raw text up to the first line starting with </connection>
    if (inConn && lead.startsWith('</connection>')) {
      if (inline) throw new Error('The profile has an unfinished <' + inline + '> block.');
      out.push('</connection>'); inConn = false; continue;
    }
    // ...and an inline block up to the first line starting with its close tag
    if (inline) {
      if (lead.startsWith('</' + inline + '>')) { if (!dropBlock) out.push('</' + inline + '>'); inline = null; dropBlock = false; }
      else if (!dropBlock) {
        if (/^\s*<\/?[A-Za-z0-9-]+>/.test(raw) && !/^-----/.test(lead)) throw new Error('The profile has a broken <' + inline + '> block.');
        out.push(raw);
      }
      continue;
    }
    const tokens = tokenize(raw);
    if (tokens === null) { drop('unreadable line'); continue; }
    if (!tokens.length) continue;
    let name = tokens[0];
    if (name[0] === '<') {
      const m = /^<([a-z0-9-]+)>$/.exec(name);
      if (!m) { drop(name.slice(0, 30)); continue; }
      const tag = m[1];
      if (tag === 'connection') {
        if (inConn) throw new Error('Nested <connection> blocks are not supported.');
        inConn = true; out.push('<connection>'); continue;
      }
      inline = tag;
      if (INLINE.has(tag)) { out.push('<' + tag + '>'); if (tag === 'auth-user-pass') inlineAuth = true; }
      else { dropBlock = true; drop('<' + tag + '>'); }
      continue;
    }
    if (name.startsWith('--')) name = name.slice(2);
    if (!/^[a-z0-9-]+$/.test(name) || !ALLOW.has(name)) { drop(name.slice(0, 30) || 'unknown'); continue; }
    if (name === 'auth-nocache') { drop(name); continue; }
    const args = tokens.slice(1);
    if (FILE_ARGS.has(name) && args[0] !== undefined && args[0] !== '[inline]') {
      throw new Error('This profile uses a separate file for "' + name + '" (' + args[0] + '). ' +
        'Export it as a single .ovpn file with the certificates inside.');
    }
    if (name === 'auth-user-pass' || name === 'askpass') {     // never read a password file; ask over management
      if (name === 'auth-user-pass') needsAuth = true;
      if (args.length && args[0] !== '[inline]') drop(name + ' <file>');
      out.push(name); continue;
    }
    if ((name === 'http-proxy' || name === 'socks-proxy') && args.length > 2 && !/^(auto|auto-nct|stdin)$/.test(args[2])) {
      drop(name + ' <file>'); args.length = 2;               // third argument would be a credentials file
    }
    if (name === 'remote') { hasRemote = true; if (!remote) remote = args.slice(0, 2).join(':'); }
    out.push([name].concat(args).map(quoteToken).join(' '));
  }
  if (inline) throw new Error('The profile has an unfinished <' + inline + '> block.');
  if (inConn) throw new Error('The profile has an unfinished <connection> block.');
  if (!hasRemote) throw new Error('No "remote" line: this does not look like an OpenVPN client profile.');
  return { text: out.join('\n') + '\n', removed, needsAuth: needsAuth && !inlineAuth, remote };
}

// ------------------------------------------------------------------ profile store
function listProfiles() {
  let names = [];
  try { names = fs.readdirSync(PROFILES); } catch (e) { return []; }
  return names.filter((n) => /^[a-f0-9]{16}\.json$/.test(n)).map((n) => {
    const id = n.slice(0, 16);
    const meta = readJson(path.join(PROFILES, n), {});
    return { id, name: meta.name || id, remote: meta.remote || '', needsAuth: !!meta.needsAuth,
      removed: meta.removed || [], created: meta.created || 0, saved: fs.existsSync(path.join(CREDS, id + '.json')) };
  }).sort((a, b) => a.created - b.created);
}

function saveProfile(name, text, creds) {
  ensureDirs();
  if (creds && creds.username) { cleanSecret(creds.username); cleanSecret(creds.password); }   // throws before anything is written
  const s = sanitizeProfile(text);
  const id = crypto.randomBytes(8).toString('hex');
  name = String(name || 'VPN').replace(/\.(ovpn|conf)$/i, '').replace(/[^\w .()+@-]/g, '').trim().slice(0, 40) || 'VPN';
  fs.writeFileSync(path.join(PROFILES, id + '.ovpn'), s.text, { mode: 0o600 });
  writeJson(path.join(PROFILES, id + '.json'), { name, remote: s.remote, needsAuth: s.needsAuth, removed: s.removed, created: Date.now() });
  if (creds && creds.username) writeJson(path.join(CREDS, id + '.json'), { u: cleanSecret(creds.username), p: cleanSecret(creds.password) });
  const settings = readJson(SETTINGS, {});
  if (!settings.selected) { settings.selected = id; writeJson(SETTINGS, settings); }
  emitProfiles();
  return Object.assign({ id, name }, { removed: s.removed, needsAuth: s.needsAuth });
}

function deleteProfile(id) {
  for (const f of [path.join(PROFILES, id + '.ovpn'), path.join(PROFILES, id + '.json'), path.join(CREDS, id + '.json')]) {
    try { fs.unlinkSync(f); } catch (e) { /* gone */ }
  }
  const settings = readJson(SETTINGS, {});
  if (settings.selected === id) { const rest = listProfiles(); settings.selected = rest.length ? rest[0].id : null; writeJson(SETTINGS, settings); }
  emitProfiles();
}

// ------------------------------------------------------------------ state + subscribers
const st = { state: 'DISCONNECTED', detail: '', localIp: '', remoteIp: '', since: 0, bytesIn: 0, bytesOut: 0,
  profile: null, profileName: '', error: '', need: null, details: {}, reconnects: 0 };
const logLines = [];
const subs = new Set();
function emit(ev) {
  for (const m of subs) {
    try { m.respond(Object.assign({ returnValue: true, subscribed: true }, ev)); } catch (e) { subs.delete(m); }
  }
}
function emitStatus() { emit({ status: st }); }
function emitProfiles() { emit({ profiles: listProfiles(), selected: readJson(SETTINGS, {}).selected || null }); }
function pushLog(line) {
  logLines.push(line);
  if (logLines.length > 300) logLines.splice(0, logLines.length - 300);
  emit({ log: [line] });
}
function setState(name, extra) {
  st.state = name;
  Object.assign(st, extra || {});
  emitStatus();
}
let bytesTimer = null;

// ------------------------------------------------------------------ management socket
let mg = null, mgBuf = '', mgWait = [];
let attaching = null;   // list of callbacks while re-attaching to an openvpn left running by an earlier service instance
function whenAttached(fn) { if (attaching) attaching.push(fn); else fn(); }
function attachDone() { const l = attaching; attaching = null; if (l) l.forEach((fn) => fn()); }
let pending = null;   // { username, password } until openvpn has taken them
let stopping = false;

function mgConnect(cb) {
  const s = net.connect(SOCK);
  s.setEncoding('utf8');
  let done = false;
  s.on('connect', () => { done = true; mg = s; mgBuf = ''; mgWait = []; cb && cb(null); mgSetup(); });
  s.on('error', (e) => { if (!done) { done = true; cb && cb(e); } });
  s.on('close', () => {
    if (mg !== s) return;
    mg = null;
    mgWait.forEach((w) => w.cb && w.cb(new Error('management closed')));
    mgWait = [];
    onVpnGone();
  });
  s.on('data', (d) => {
    mgBuf += d;
    let i;
    while ((i = mgBuf.indexOf('\n')) >= 0) {
      const line = mgBuf.slice(0, i).replace(/\r$/, '');
      mgBuf = mgBuf.slice(i + 1);
      mgLine(line);
    }
  });
}

function mgCmd(cmd, multi, cb) {
  if (!mg) { if (cb) cb(new Error('OpenVPN is not running')); return; }
  mgWait.push({ multi, lines: [], cb });
  mg.write(cmd + '\n');
}
// Management commands are line based: a CR/LF inside a value would end the command and start another one.
function cleanSecret(v) { v = String(v == null ? '' : v); if (/[\r\n\0]/.test(v)) throw new Error('Username and password cannot contain line breaks.'); return v.slice(0, 1024); }
function quote(s) { return '"' + cleanSecret(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
function sendAuth(type, username, password) {
  let u, pw;
  try { u = type === 'Auth' ? quote(username) : null; pw = quote(password); } catch (e) { setState(st.state, { error: e.message }); return false; }
  if (type === 'Auth') { mgCmd('username "Auth" ' + u, false); mgCmd('password "Auth" ' + pw, false); }
  else mgCmd('password ' + quote(type) + ' ' + pw, false);
  return true;
}

function mgLine(line) {
  if (line[0] === '>') return mgRealtime(line);
  const w = mgWait[0];
  if (!w) return;
  if (w.multi) {
    if (line === 'END') { mgWait.shift(); if (w.cb) w.cb(null, w.lines); }
    else if (!w.lines.length && /^ERROR:/.test(line)) { mgWait.shift(); if (w.cb) w.cb(new Error(line.slice(6).trim())); }
    else w.lines.push(line);
    return;
  }
  mgWait.shift();
  if (/^ERROR:/.test(line)) { if (w.cb) w.cb(new Error(line.slice(6).trim())); } else if (w.cb) w.cb(null, line);
}

function parseState(fields) {
  // time,NAME,desc,local_ip,remote_ip,remote_port,local_addr,local_port,local_ipv6
  const name = fields[1] || 'UNKNOWN';
  const extra = { detail: fields[2] || '' };
  if (name === 'RECONNECTING' && st.state !== 'RECONNECTING') st.reconnects = (st.reconnects || 0) + 1;
  if (name === 'CONNECTED') {
    extra.localIp = fields[3] || '';
    extra.remoteIp = fields[4] || '';
    extra.since = (parseInt(fields[0], 10) || 0) * 1000;
    extra.error = '';
    extra.need = null;
    if (pending && pending.remember && pending.username && st.profile) {
      writeJson(path.join(CREDS, st.profile + '.json'), { u: pending.username, p: pending.password || '' });
      emitProfiles();
    }
    pending = null; // openvpn keeps its own copy (no auth-nocache), ours is no longer needed
  } else if (name !== 'ASSIGN_IP' && name !== 'ADD_ROUTES') {
    extra.since = 0;
  }
  if (name === 'EXITING' && /auth-failure/i.test(fields[2] || '')) { extra.error = 'Wrong username or password.'; touch(STOP_FLAG); }
  setState(name, extra);
}

function mgRealtime(line) {
  const i = line.indexOf(':');
  const kind = line.slice(1, i), body = line.slice(i + 1);
  if (kind === 'STATE') parseState(body.split(','));
  else if (kind === 'LOG') {
    const f = body.split(','), text = f.slice(2).join(',');
    pushLog(fmtTime(f[0]) + ' ' + text);
    if (parseDetail(text)) emit({ details: st.details });
  }
  else if (kind === 'BYTECOUNT') {
    const [a, b] = body.split(',');
    st.bytesIn = parseInt(a, 10) || 0; st.bytesOut = parseInt(b, 10) || 0;
    emit({ bytes: { in: st.bytesIn, out: st.bytesOut } });
  } else if (kind === 'HOLD') {
    mgCmd('hold release', false);
  } else if (kind === 'PASSWORD') {
    // ">PASSWORD:Need 'Auth' username/password", ">PASSWORD:Verification Failed: 'Auth'"
    const m = /^(Need|Verification Failed):? '([^']+)'/.exec(body);
    if (!m) return;
    const type = m[2];
    if (m[1] === 'Verification Failed') {
      if (type === 'Auth' && st.profile && (!pending || pending.fromSaved)) {   // a saved login stopped working: ask again
        rm(path.join(CREDS, st.profile + '.json'));
        emitProfiles();
      }
      pending = null;
      touch(STOP_FLAG);   // don't let the watchdog retry a wrong password forever
      setState(st.state, { error: type === 'Auth' ? 'Wrong username or password.' : 'Wrong ' + type + ' password.' });
      return;
    }
    if (type === 'Auth' && pending && pending.username) { sendAuth('Auth', pending.username, pending.password); return; }
    if (type === 'Auth' && st.profile) {   // e.g. the service restarted while openvpn waited: use the saved login
      const saved = readJson(path.join(CREDS, st.profile + '.json'), null);
      if (saved) { if (pending) pending.fromSaved = true; else pending = { fromSaved: true }; sendAuth('Auth', saved.u, saved.p); return; }
    }
    if (type !== 'Auth' && pending && pending[type]) { sendAuth(type, null, pending[type]); return; }
    setState(st.state, { need: type });   // the app asks the user and calls 'auth'
  } else if (kind === 'FATAL') {
    setState(st.state, { error: body });
  }
}

// Connection details for the app, read from openvpn's own log lines.
function parseDetail(text) {
  const d = st.details;
  let m;
  if ((m = /^(UDPv[46]|TCPv[46]_CLIENT|TCPv[46]|UDP|TCP)\S* link remote: \[AF_INET6?\](.+):(\d+)$/.exec(text))) {
    d.protocol = m[1].replace('_CLIENT', ''); d.server = m[2]; d.port = m[3];
  } else if ((m = /^(UDPv[46]|TCPv[46]\S*) link local(?: \(bound\))?: (.*)$/.exec(text))) {
    d.localBind = m[2].replace(/\[AF_INET6?\]/, '');
  } else if ((m = /^VERIFY OK: depth=0, (.*)$/.exec(text))) {
    d.serverCert = m[1];
  } else if ((m = /^VERIFY OK: depth=1, (.*)$/.exec(text))) {
    d.serverCa = m[1];
  } else if ((m = /^Control Channel: (TLSv[\d.]+), cipher (?:TLSv[\d.]+ )?(\S+?),?(?: |$)(.*)$/.exec(text))) {
    d.tls = m[1]; d.tlsCipher = m[2];
    const ka = /key agreement: ([^,]+)/.exec(m[3] || ''); if (ka) d.keyAgreement = ka[1];
    const pk = /peer certificate: ([^,]+)/.exec(m[3] || ''); if (pk) d.peerKey = pk[1];
  } else if ((m = /^Data Channel: cipher '([^']+)'(?:, peer-id: (\d+))?/.exec(text)) || (m = /Data Channel: Cipher '([^']+)'/.exec(text))) {
    d.dataCipher = m[1]; if (m[2]) d.peerId = m[2];
  } else if ((m = /^TUN\/TAP device (\S+) opened$/.exec(text))) {
    d.iface = m[1];
  } else if ((m = /^PUSH: Received control message: '(.*)'$/.exec(text))) {
    const dns = [], routes = [];
    let redirect = '';
    for (const opt of m[1].split(',').slice(1)) {
      const w = opt.trim().split(/\s+/);
      if (w[0] === 'dhcp-option' && /^DNS6?$/.test(w[1])) dns.push(w[2]);
      else if (w[0] === 'dhcp-option' && w[1] === 'DOMAIN') d.domain = w[2];
      else if (w[0] === 'dns' && w[1] === 'server' && w[3] === 'address') dns.push(w.slice(4).join(' '));
      else if (w[0] === 'redirect-gateway') redirect = w.slice(1).join(' ') || 'on';
      else if (w[0] === 'route-gateway') d.gateway = w[1];
      else if (w[0] === 'route') routes.push(w[1] + (w[2] ? '/' + maskBits(w[2]) : ''));
      else if (w[0] === 'route-ipv6') routes.push(w[1]);
      else if (w[0] === 'ifconfig') { d.vpnIp = w[1]; d.netmask = w[2]; }
      else if (w[0] === 'ifconfig-ipv6') d.vpnIp6 = w[1];
      else if (w[0] === 'tun-mtu') d.mtu = w[1];
      else if (w[0] === 'topology') d.topology = w[1];
      else if (w[0] === 'ping') d.ping = w[1];
      else if (w[0] === 'ping-restart') d.pingRestart = w[1];
      else if (w[0] === 'cipher') d.pushedCipher = w[1];
      else if (w[0] === 'peer-id') d.peerId = w[1];
      else if (w[0] === 'compress' || w[0] === 'comp-lzo') d.compression = w.join(' ');
    }
    d.dns = dns;
    d.routes = routes;
    d.redirect = redirect;
  } else if (/^Initialization Sequence Completed/.test(text)) {
    d.completed = true;
  } else if ((m = /^OpenVPN (\d[\d.]+) /.exec(text))) {
    d.openvpn = m[1];
  } else return false;
  return true;
}
function maskBits(mask) {
  const p = String(mask).split('.').map(Number);
  if (p.length !== 4 || p.some(isNaN)) return mask;
  return p.reduce((n, o) => n + o.toString(2).split('').filter((c) => c === '1').length, 0);
}

function fmtTime(t) {
  const d = new Date((parseInt(t, 10) || 0) * 1000);
  const p = (n) => (n < 10 ? '0' : '') + n;
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function mgSetup() {
  const cur = readJson(CURRENT, {});
  st.profile = cur.id || null;
  st.profileName = cur.name || '';
  mgCmd('log all', true, (e, lines) => {
    if (!e && lines) {
      logLines.length = 0;
      st.details = {};
      for (const l of lines) {
        const f = l.split(','), text = f.slice(2).join(',');
        logLines.push(fmtTime(f[0]) + ' ' + text);
        parseDetail(text);
      }
      if (logLines.length > 300) logLines.splice(0, logLines.length - 300);
      emit({ logReset: logLines, details: st.details });
    }
  });
  mgCmd('log on', false);
  mgCmd('state', true, (e, lines) => { if (!e && lines && lines.length) parseState(lines[lines.length - 1].split(',')); attachDone(); });
  mgCmd('state on', false);
  mgCmd('bytecount 2', false);
}

function onVpnGone() {
  const err = st.error;
  stopping = false;
  pending = null;
  rm(CURRENT);
  if (!vpnPid()) rm(PIDFILE);
  setState('DISCONNECTED', { detail: '', localIp: '', remoteIp: '', since: 0, need: null, error: err });
}

// ------------------------------------------------------------------ start / stop
// The pid in the pidfile only counts if that process really is our openvpn (pids get reused after a crash).
function isOurOpenvpn(pid) {
  if (!pid) return false;
  try { return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').indexOf(path.join(__dirname, 'bin', 'libexec', 'openvpn')) >= 0; }
  catch (e) { return false; }
}
function vpnPid() {
  const pid = parseInt(readFileSafe(PIDFILE), 10);
  return isOurOpenvpn(pid) ? pid : 0;
}
function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } }

let starting = false, killTimer = null;
function startVpn(id, creds, cb0) {
  try { ensureDirs(); } catch (e) { return cb0(e); }
  const conf = path.join(PROFILES, id + '.ovpn');
  if (!fs.existsSync(conf)) return cb0(new Error('Profile not found.'));
  if (starting || mg || vpnPid()) return cb0(new Error('A VPN connection is already running.'));
  starting = true;
  const cb = (e) => { starting = false; cb0(e); };
  if (killTimer) { clearTimeout(killTimer); killTimer = null; }
  const meta = readJson(path.join(PROFILES, id + '.json'), {});
  try { fs.unlinkSync(SOCK); } catch (e) { /* none */ }
  writeJson(CURRENT, { id, name: meta.name || '' });
  pending = creds || {};
  rm(STOP_FLAG);
  applyKeepConnected();
  startWatchdog();
  logLines.length = 0;
  emit({ logReset: [] });
  setState('STARTING', { profile: id, profileName: meta.name || '', error: '', need: null, detail: '', bytesIn: 0, bytesOut: 0,
    details: {}, reconnects: 0, startedAt: Date.now() });
  const out = fs.openSync(LOGFILE, 'w', 0o600);
  const args = ['--config', conf,
    '--script-security', '1',              // never run external programs, whatever the profile says
    '--management', SOCK, 'unix', '--management-hold', '--management-query-passwords',
    '--auth-retry', 'none', '--pull-filter', 'ignore', 'register-dns', '--pull-filter', 'ignore', 'block-outside-dns',
    '--writepid', PIDFILE, '--verb', '3'];
  if (lanAccess()) {
    // Keep local networks off the tunnel. Without this, a VPN that takes all traffic (redirect-gateway) also takes the
    // TV's replies to devices on other local subnets (e.g. a phone/PC on 192.168.1.x talking to a TV on 192.168.2.x),
    // so they lose contact with the TV. More specific routes pushed by the VPN still win.
    args.push('--route', '10.0.0.0', '255.0.0.0', 'net_gateway', '--route', '172.16.0.0', '255.240.0.0', 'net_gateway',
      '--route', '192.168.0.0', '255.255.0.0', 'net_gateway');
  }
  let child;
  try {
    // Clean environment: the webOS service environment points the loader at the TV's glibc libraries
    // (LD_LIBRARY_PATH/LD_PRELOAD), which breaks the bundled musl openvpn.
    child = spawn(BIN, args, { detached: true, stdio: ['ignore', out, out], cwd: RUN,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/home/root', LANG: 'C' } });
  } catch (e) { fs.closeSync(out); setState('DISCONNECTED', { error: e.message }); return cb(e); }
  fs.closeSync(out);
  child.on('error', (e) => setState('DISCONNECTED', { error: 'Could not start openvpn: ' + e.message }));
  child.on('exit', (code) => {
    if (!mg) {
      const tail = readFileSafe(LOGFILE).trim().split('\n').slice(-3).join(' | ');
      if (code && !st.error) st.error = 'openvpn stopped (code ' + code + ')' + (tail ? ': ' + tail : '');
      onVpnGone();
    }
  });
  child.unref();
  let tries = 0;
  (function attempt() {
    mgConnect((e) => {
      if (!e) return cb(null);
      if (++tries > 50 || child.exitCode !== null) { return cb(new Error('openvpn did not start: ' + (readFileSafe(LOGFILE).trim().split('\n').pop() || e.message))); }
      setTimeout(attempt, 200);
    });
  })();
}

// Resolves once openvpn has taken the credentials (CONNECTED) or given up, so the service (which exits when idle)
// stays alive long enough to answer openvpn's password request.
function whenSettled(cb) {
  const t0 = Date.now();
  (function check() {
    if (st.state === 'CONNECTED' || st.state === 'DISCONNECTED' || st.error || st.need || Date.now() - t0 > 60000) return cb();
    setTimeout(check, 300);
  })();
}

function stopVpn(cb) {
  stopping = true;
  pending = null;
  touch(STOP_FLAG);
  const pid = vpnPid();
  if (mg || pid) setState('DISCONNECTING');
  mgCmd('signal SIGTERM', false, () => {});
  if (!mg && pid) { try { process.kill(pid, 'SIGTERM'); } catch (e) { /* gone */ } }
  // explicit-exit-notify can take a few seconds; make sure *this* openvpn really ends (never a newer one)
  if (pid) {
    if (killTimer) clearTimeout(killTimer);
    const t0 = Date.now();
    (function check() {
      if (!isOurOpenvpn(pid)) { killTimer = null; if (!mg) onVpnGone(); return; }
      if (Date.now() - t0 > 6000) { try { process.kill(pid, 'SIGKILL'); } catch (e) { /* gone */ } }
      killTimer = setTimeout(check, 300);
    })();
  } else if (!mg) onVpnGone();
  cb && cb();
}

// ------------------------------------------------------------------ LAN upload page
let upload = null; // the open import session: { server, code, msg, sockets, fails, timer, closed }
function lanAddresses() {
  const res = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    if (/^(tun|tap|lo)/.test(name)) continue;
    for (const a of ifs[name]) if (a.family === 'IPv4' && !a.internal) res.push({ name, address: a.address });
  }
  res.sort((a, b) => (a.name === 'eth0' ? -1 : 0) - (b.name === 'eth0' ? -1 : 0));
  return res;
}

const UPLOAD_PAGE = fs.readFileSync(path.join(__dirname, 'upload.html'), 'utf8');

function stopUpload(sess) {
  const u = sess || upload;
  if (!u || u.closed) return;
  u.closed = true;
  if (upload === u) upload = null;
  clearTimeout(u.timer);
  try { u.server.close(); } catch (e) { /* closed */ }
  for (const sk of u.sockets) sk.destroy();
  try { u.msg.respond({ returnValue: true, subscribed: false, closed: true }); } catch (e) { /* app gone */ }
}

function startUpload(msg) {
  stopUpload();
  const sess = { code: String(crypto.randomInt(0, 1000000)).padStart(6, '0'), msg, sockets: new Set(), fails: 0, closed: false };
  const server = http.createServer((req, res) => {
    const send = (status, body, type) => {
      if (res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (sess.closed) return send(410, { error: 'The import screen on the TV was closed.' });
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) return send(200, UPLOAD_PAGE, 'text/html; charset=utf-8');
    if (req.method !== 'POST' || req.url !== '/upload') return send(404, { error: 'Not found' });
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > MAX_PROFILE * 2 + 8192) { send(413, { error: 'File too big.' }); req.destroy(); } else chunks.push(d);
    });
    req.on('end', () => {
      try {
        if (res.writableEnded) return;
        if (sess.closed || sess.fails >= 5) return send(403, { error: 'Too many wrong codes. Start the import again on the TV.' });
        let j;
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return send(400, { error: 'Bad request.' }); }
        if (!j || typeof j !== 'object' || typeof j.code !== 'string' || typeof j.text !== 'string') return send(400, { error: 'Bad request.' });
        const given = Buffer.from(/^\d{6}$/.test(j.code) ? j.code : '------', 'latin1');
        if (!crypto.timingSafeEqual(given, Buffer.from(sess.code, 'latin1'))) {
          if (++sess.fails >= 5) { send(403, { error: 'Too many wrong codes. Start the import again on the TV.' }); stopUpload(sess); return; }
          return send(403, { error: 'Wrong code. Check the code shown on the TV.' });
        }
        const creds = typeof j.username === 'string' && j.username ? { username: j.username, password: typeof j.password === 'string' ? j.password : '' } : null;
        const r = saveProfile(typeof j.name === 'string' ? j.name : '', j.text, creds);
        send(200, { ok: true, name: r.name, removed: r.removed });
        try { msg.respond({ returnValue: true, subscribed: true, imported: r }); } catch (e) { /* app gone */ }
      } catch (e) { send(400, { error: e.message || 'Bad request.' }); }
    });
    req.on('error', () => { /* client went away */ });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxConnections = 8;
  server.setTimeout(20000, (sk) => sk.destroy());
  server.on('connection', (sk) => { sess.sockets.add(sk); sk.on('close', () => sess.sockets.delete(sk)); });
  server.on('clientError', (e, sk) => { try { sk.destroy(); } catch (x) { /* gone */ } });
  server.on('error', (e) => { if (upload === sess) upload = null; sess.closed = true; fail(msg, 'Could not open the upload page: ' + e.message); });
  sess.server = server;
  upload = sess;
  server.listen(UPLOAD_PORT, '0.0.0.0', () => {
    if (sess.closed) return;
    sess.timer = setTimeout(() => stopUpload(sess), 15 * 60 * 1000);
    msg.respond({ returnValue: true, subscribed: true, code: sess.code, port: UPLOAD_PORT,
      urls: lanAddresses().map((a) => 'http://' + a.address + ':' + UPLOAD_PORT + '/') });
  });
}

// ------------------------------------------------------------------ USB
function scanUsb() {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 5 || found.length > 50) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.name[0] === '.' || e.name === 'System Volume Information' || e.name === '$RECYCLE.BIN') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && /\.(ovpn|conf)$/i.test(e.name)) {
        try { const sz = fs.statSync(p).size; if (sz > 0 && sz <= MAX_PROFILE) found.push({ path: p, name: e.name, size: sz }); } catch (x) { /* skip */ }
      }
    }
  };
  for (const r of USB_ROOTS) walk(r, 0);
  return found;
}
function usbAllowed(p) {
  let real;
  try { real = fs.realpathSync(p); } catch (e) { return null; }
  return USB_ROOTS.some((r) => real.startsWith(r + '/')) ? real : null;
}

// ------------------------------------------------------------------ luna methods
// Only this app (and luna-send, i.e. the watchdog or a root shell) may drive the VPN.
const CALLERS = /^(com\.homebrew\.openvpn(\.|$)|com\.webos\.lunasend)/;
function needRoot(msg) {
  if (!CALLERS.test(String(msg.sender || ''))) { fail(msg, 'Not allowed for ' + (msg.sender || 'unknown caller')); return true; }
  if (isRoot()) return false;
  fail(msg, 'The service is not running as root yet.', { notRoot: true });
  return true;
}

service.register('getInfo', (msg) => {
  ok(msg, { version: pkg.version, uid: process.getuid ? process.getuid() : -1, root: isRoot(),
    tun: fs.existsSync('/dev/net/tun'), binary: fs.existsSync(BIN) });
});

// ('quit' is built into webos-service: the app calls it after elevation so the service restarts as root)

function onCancel(msg) {
  subs.delete(msg);
  if (upload && upload.msg === msg) stopUpload(upload);
}

service.register('status', (msg) => {
  if (needRoot(msg)) return;
  whenAttached(() => statusReply(msg));
}, onCancel);

function statusReply(msg) {
  const settings = readJson(SETTINGS, {});
  const snap = { status: st, log: logLines, profiles: listProfiles(), selected: settings.selected || null, keepConnected: settings.keepConnected !== false,
    lanAccess: settings.lanAccess !== false };
  if (msg.isSubscription) {
    subs.add(msg);
    msg.respond(Object.assign({ returnValue: true, subscribed: true }, snap));
  } else ok(msg, snap);
}

service.register('select', (msg) => {
  if (needRoot(msg)) return;
  const id = msg.payload.id;
  if (!validId(id) || !fs.existsSync(path.join(PROFILES, id + '.ovpn'))) return fail(msg, 'Profile not found.');
  const settings = readJson(SETTINGS, {});
  settings.selected = id;
  writeJson(SETTINGS, settings);
  emitProfiles();
  ok(msg);
});

service.register('connect', (msg) => {
  if (needRoot(msg)) return;
  whenAttached(() => connectReq(msg));
});
function connectReq(msg) {
  const p = msg.payload;
  const id = p.id;
  if (!validId(id)) return fail(msg, 'Choose a profile first.');
  const meta = readJson(path.join(PROFILES, id + '.json'), null);
  if (!meta) return fail(msg, 'Profile not found.');
  let creds = {};
  if (meta.needsAuth) {
    if (p.username) {
      try { creds = { username: cleanSecret(p.username), password: cleanSecret(p.password) }; } catch (e) { return fail(msg, e.message); }
      creds.remember = !!p.remember;     // saved once openvpn reports CONNECTED, never before the server accepted it
      if (!p.remember) rm(path.join(CREDS, id + '.json'));
    } else {
      const saved = readJson(path.join(CREDS, id + '.json'), null);
      if (!saved) return fail(msg, 'Username and password needed.', { needCreds: true });
      creds = { username: saved.u, password: saved.p, fromSaved: true };
    }
  }
  if (p.keyPassword) creds['Private Key'] = String(p.keyPassword);
  startVpn(id, creds, (e) => (e ? fail(msg, e.message) : whenSettled(() => ok(msg))));
}

// Called by watchdog.sh (at boot and when openvpn is gone): reconnect the selected profile with saved credentials.
service.register('autoConnect', (msg) => {
  if (needRoot(msg)) return;
  whenAttached(() => autoConnectReq(msg));
});
function autoConnectReq(msg) {
  if (!keepConnected() || fs.existsSync(STOP_FLAG)) return ok(msg, { skipped: 'off' });
  if (mg || vpnPid()) return ok(msg, { skipped: 'running' });
  const id = readJson(SETTINGS, {}).selected;
  const meta = validId(id) ? readJson(path.join(PROFILES, id + '.json'), null) : null;
  if (!meta) return ok(msg, { skipped: 'no profile' });
  let creds = {};
  if (meta.needsAuth) {
    const saved = readJson(path.join(CREDS, id + '.json'), null);
    if (!saved) return ok(msg, { skipped: 'no saved password' });
    creds = { username: saved.u, password: saved.p, fromSaved: true };
  }
  startVpn(id, creds, (e) => {
    if (e) return fail(msg, e.message);
    whenSettled(() => {
      if (st.need && !subs.size) { stopVpn(); st.error = 'OpenVPN needs the ' + st.need + ' password: open the app to connect.'; }
      ok(msg, { state: st.state });
    });
  });
}

service.register('setLanAccess', (msg) => {
  if (needRoot(msg)) return;
  const settings = readJson(SETTINGS, {});
  settings.lanAccess = !!msg.payload.on;
  writeJson(SETTINGS, settings);
  emit({ lanAccess: settings.lanAccess });
  ok(msg, { lanAccess: settings.lanAccess });
});

service.register('setKeepConnected', (msg) => {
  if (needRoot(msg)) return;
  const settings = readJson(SETTINGS, {});
  settings.keepConnected = !!msg.payload.on;
  writeJson(SETTINGS, settings);
  applyKeepConnected();
  if (settings.keepConnected && (mg || vpnPid())) startWatchdog();
  emit({ keepConnected: settings.keepConnected });
  ok(msg, { keepConnected: settings.keepConnected });
});

service.register('auth', (msg) => {
  if (needRoot(msg)) return;
  const p = msg.payload;
  if (!mg) return fail(msg, 'OpenVPN is not running.');
  const type = String(p.type || 'Auth');
  if (!/^[A-Za-z0-9 _-]{1,40}$/.test(type)) return fail(msg, 'Bad request.');
  try { cleanSecret(p.username); cleanSecret(p.password); } catch (e) { return fail(msg, e.message); }
  sendAuth(type, p.username, p.password);
  setState(st.state, { need: null });
  ok(msg);
});

service.register('disconnect', (msg) => {
  if (needRoot(msg)) return;
  stopVpn(() => ok(msg));
});

service.register('deleteProfile', (msg) => {
  if (needRoot(msg)) return;
  const id = msg.payload.id;
  if (!validId(id)) return fail(msg, 'Profile not found.');
  if (st.profile === id && st.state !== 'DISCONNECTED') return fail(msg, 'Disconnect before deleting this profile.');
  deleteProfile(id);
  ok(msg);
});

service.register('forgetPassword', (msg) => {
  if (needRoot(msg)) return;
  const id = msg.payload.id;
  if (!validId(id)) return fail(msg, 'Profile not found.');
  try { fs.unlinkSync(path.join(CREDS, id + '.json')); } catch (e) { /* none */ }
  emitProfiles();
  ok(msg);
});

service.register('importStart', (msg) => {
  if (needRoot(msg)) return;
  if (!msg.isSubscription) return fail(msg, 'importStart needs subscribe:true');
  startUpload(msg);
}, onCancel);
service.register('importStop', (msg) => { if (needRoot(msg)) return; stopUpload(); ok(msg); });

service.register('usbScan', (msg) => {
  if (needRoot(msg)) return;
  ok(msg, { files: scanUsb() });
});

service.register('usbImport', (msg) => {
  if (needRoot(msg)) return;
  const real = usbAllowed(String(msg.payload.path || ''));
  if (!real) return fail(msg, 'File not found on a USB drive.');
  try {
    if (fs.statSync(real).size > MAX_PROFILE) throw new Error('The file is too big for an OpenVPN profile.');
    const r = saveProfile(path.basename(real), fs.readFileSync(real, 'utf8'), null);
    ok(msg, { imported: r });
  } catch (e) { fail(msg, e.message); }
});

// ------------------------------------------------------------------ startup: pick up a VPN left running
if (isRoot()) {
  try { ensureDirs(); } catch (e) { /* reported by calls */ }
  // keep the boot hook current (e.g. after an update) once the user has turned Keep connected on by connecting
  if (fs.existsSync(KEEP_FLAG) || fs.existsSync(INITD)) applyKeepConnected();
  if (fs.existsSync(SOCK)) {
    attaching = [];
    setTimeout(attachDone, 3000);   // never hold callers longer than this
    mgConnect((e) => { if (e) { if (!vpnPid()) rm(SOCK); attachDone(); } });
  }
}

module.exports = { sanitizeProfile, tokenize, parseDetail, st };   // for tools/test
