/* OpenVPN for webOS - TV app. Created by aning with Claude. */
(function () {
  'use strict';
  var SVC = 'luna://com.homebrew.openvpn.service/';
  var ELEVATE = '/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service com.homebrew.openvpn.service';
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, OK: 13, BACK: 461, ESC: 27 };
  var STATE_NAMES = {
    STARTING: 'Starting', CONNECTING: 'Connecting', RESOLVE: 'Looking up server', TCP_CONNECT: 'Connecting',
    WAIT: 'Waiting for server', AUTH: 'Signing in', GET_CONFIG: 'Getting settings', ASSIGN_IP: 'Setting up address',
    ADD_ROUTES: 'Setting up routes', AUTH_PENDING: 'Waiting for approval'
  };
  var $ = function (id) { return document.getElementById(id); };

  var S = { status: { state: 'DISCONNECTED' }, profiles: [], selected: null, keep: true, log: [], publicIp: '', ipKey: '',
    lan: true, tab: 'details', speed: { in: 0, out: 0 }, lastBytes: null };
  var statusSub = null, importSub = null, lastBack = 0, toastTimer = null, focused = null;
  var creds = { mode: null, type: 'Auth', remember: true };
  var bridges = [];
  var elevatedOnce = false;

  // ------------------------------------------------------------------ luna
  function luna(uri, params, cb, subscribe) {
    if (typeof PalmServiceBridge === 'undefined') {
      setTimeout(function () { if (cb) cb({ returnValue: false, errorText: 'Not running on webOS (no luna bus)' }); }, 0);
      return { cancel: function () {} };
    }
    var b = new PalmServiceBridge();
    bridges.push(b);
    var done = function () { var i = bridges.indexOf(b); if (i >= 0) bridges.splice(i, 1); };
    b.onservicecallback = function (s) {
      var r;
      try { r = JSON.parse(s); } catch (e) { return; }
      if (!subscribe) done();
      if (cb) cb(r);
    };
    params = params || {};
    if (subscribe) params.subscribe = true;
    b.call(uri.indexOf('luna://') === 0 ? uri : SVC + uri, JSON.stringify(params));
    return { cancel: function () { try { b.cancel(); } catch (e) { /* gone */ } done(); } };
  }

  // ------------------------------------------------------------------ helpers
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtBytes(n) {
    n = n || 0;
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + ' ' + u[i];
  }
  function fmtDur(ms) {
    var s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    s %= 60;
    return (h ? h + ':' : '') + (h && m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function toast(text, ms) {
    var t = $('toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    if (ms !== 0) toastTimer = setTimeout(function () { t.classList.add('hidden'); }, ms || 3500);
  }
  function hideToast() { clearTimeout(toastTimer); $('toast').classList.add('hidden'); }
  function selProfile() {
    for (var i = 0; i < S.profiles.length; i++) if (S.profiles[i].id === S.selected) return S.profiles[i];
    return null;
  }
  function isDown() { return S.status.state === 'DISCONNECTED'; }

  // ------------------------------------------------------------------ focus / navigation
  var overlayStack = [];   // open dialogs, last = on top (DOM order says nothing about which opened last)
  function topOverlay() {
    overlayStack = overlayStack.filter(function (o) { return !o.classList.contains('hidden'); });
    return overlayStack.length ? overlayStack[overlayStack.length - 1] : null;
  }
  function focusables() {
    var root = topOverlay() || $('app');
    return Array.prototype.filter.call(root.querySelectorAll('.f'), function (el) { return el.offsetParent !== null && !el.disabled; });
  }
  function setFocus(el) {
    if (focused && focused !== el) focused.classList.remove('focus');
    focused = el;
    if (!el) return;
    el.classList.add('focus');
    if (el.closest && el.closest('.profiles, .usb-list') && el.scrollIntoView) {
      try { el.scrollIntoView({ block: 'nearest' }); } catch (e) { el.scrollIntoView(false); }
    }
    var a = document.activeElement;
    if (a && a.tagName === 'INPUT' && a !== el) a.blur();
  }
  function ensureFocus(prefer) {
    var list = focusables();
    if (focused && list.indexOf(focused) >= 0) return;
    setFocus((prefer && list.indexOf(prefer) >= 0) ? prefer : list[0] || null);
  }
  function move(dir) {
    var list = focusables();
    if (!list.length) return;
    if (!focused || list.indexOf(focused) < 0) return setFocus(list[0]);
    var c = focused.getBoundingClientRect(), cx = c.left + c.width / 2, cy = c.top + c.height / 2;
    var best = null, bestScore = Infinity;
    list.forEach(function (el) {
      if (el === focused) return;
      var r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, main, side;
      if (dir === KEY.DOWN) { if (r.top < c.bottom - 4) return; main = r.top - c.bottom; side = Math.abs(x - cx); }
      else if (dir === KEY.UP) { if (r.bottom > c.top + 4) return; main = c.top - r.bottom; side = Math.abs(x - cx); }
      else if (dir === KEY.RIGHT) { if (r.left < c.right - 4) return; main = r.left - c.right; side = Math.abs(y - cy); }
      else { if (r.right > c.left + 4) return; main = c.left - r.right; side = Math.abs(y - cy); }
      var score = main + side * 1.6;
      if (score < bestScore) { bestScore = score; best = el; }
    });
    if (best) setFocus(best);
  }

  document.addEventListener('keydown', function (e) {
    var k = e.keyCode, inInput = document.activeElement && document.activeElement.tagName === 'INPUT';
    if (k === KEY.BACK || k === KEY.ESC || (k === 8 && !inInput)) { e.preventDefault(); onBack(); return; }
    if (inInput) {
      if (k === KEY.OK) { e.preventDefault(); document.activeElement.blur(); move(KEY.DOWN); return; }
      if (k === KEY.UP || k === KEY.DOWN) { e.preventDefault(); document.activeElement.blur(); move(k); }
      return;   // left/right edit the text
    }
    if (k >= 37 && k <= 40) { e.preventDefault(); move(k); return; }
    if (k === KEY.OK && focused) { e.preventDefault(); activate(focused); }
  });
  document.addEventListener('mousemove', function (e) {
    var el = e.target.closest && e.target.closest('.f');
    if (el && focusables().indexOf(el) >= 0) setFocus(el);
  });
  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('.f');
    if (!el || focusables().indexOf(el) < 0) return;
    setFocus(el);
    if (el.tagName !== 'INPUT') { e.preventDefault(); activate(el); }
  });

  function activate(el) {
    if (el.tagName === 'INPUT') { el.focus(); return; }
    var act = el.getAttribute('data-act');
    if (actions[act]) actions[act](el);
  }

  function onBack() {
    var ov = topOverlay();
    if (ov) { closeOverlay(ov); return; }
    if (!isDown()) {
      // The user asked for the app to stay open while the VPN is on: Back never exits then.
      toast('The VPN stays connected. Press the Home button to watch TV; the app keeps running in the background.', 5000);
      return;
    }
    var now = Date.now();
    if (now - lastBack < 2500) { exitApp(); return; }
    lastBack = now;
    toast('Press Back again to exit', 2500);
  }
  function exitApp() {
    bridges.slice().forEach(function (b) { try { b.cancel(); } catch (e) { /* gone */ } });
    try { window.close(); } catch (e) { /* ignore */ }
    try { if (window.webOSSystem) window.webOSSystem.platformBack(); else if (window.PalmSystem) window.PalmSystem.platformBack(); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ overlays
  function openOverlay(id, prefer) {
    var el = $(id);
    overlayStack = overlayStack.filter(function (o) { return o !== el; });
    overlayStack.push(el);
    el.style.zIndex = 10 + overlayStack.length;
    el.classList.remove('hidden');
    setFocus(null);
    ensureFocus(prefer);
  }
  function closeOverlay(ov) {
    if (typeof ov === 'string') ov = $(ov);
    if (!ov || ov.classList.contains('hidden')) return;
    ov.classList.add('hidden');
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    if (ov.id === 'dlgImport') stopImport();
    if (ov.id === 'dlgCreds') {
      $('inPass').value = '';
      // openvpn is waiting for this password: cancelling means "don't connect", otherwise the prompt would come back
      if (creds.mode === 'auth' && S.status.need) luna('disconnect', {});
      creds.mode = null;
    }
    setFocus(null);
    ensureFocus($('btnMain'));
  }
  function showMsg(title, text, buttons) {
    $('msgTitle').textContent = title;
    $('msgText').textContent = text;
    var box = $('msgButtons');
    box.innerHTML = '';
    (buttons || [{ label: 'OK' }]).forEach(function (b, i) {
      var el = document.createElement('button');
      el.className = 'f' + (i === 0 ? ' primary' : '');
      el.textContent = b.label;
      el.setAttribute('data-act', 'msgBtn');
      el._fn = b.fn;
      box.appendChild(el);
    });
    openOverlay('dlgMsg', box.firstChild);
  }

  function askCreds(mode, type) {
    var p = selProfile();
    creds.mode = mode;
    creds.type = type || 'Auth';
    var isKey = creds.type !== 'Auth';
    $('credsTitle').textContent = isKey ? 'Private key password' : 'Sign in';
    $('credsSub').textContent = p ? p.name + (p.remote ? ' · ' + p.remote : '') : '';
    $('rowUser').classList.toggle('hidden', isKey);
    $('passLabel').textContent = isKey ? 'Key password' : 'Password';
    $('btnRemember').classList.toggle('hidden', mode !== 'connect' || isKey);
    $('btnRemember').classList.toggle('on', creds.remember);
    $('inPass').value = '';
    openOverlay('dlgCreds', isKey || $('inUser').value ? $('inPass') : $('inUser'));
  }

  // ------------------------------------------------------------------ actions
  var actions = {
    main: function () {
      if (!isDown()) { luna('disconnect', {}, function (r) { if (!r.returnValue) toast(r.errorText); }); return; }
      var p = selProfile();
      if (!p) { actions.import(); return; }
      if (p.needsAuth && !p.saved) { askCreds('connect'); return; }
      connect({ id: p.id });
    },
    keep: function () {
      luna('setKeepConnected', { on: !S.keep }, function (r) {
        if (!r.returnValue) return toast(r.errorText);
        S.keep = r.keepConnected;
        render();
        toast(S.keep ? 'Keep connected is on' : 'Keep connected is off');
      });
    },
    lan: function () {
      luna('setLanAccess', { on: !S.lan }, function (r) {
        if (!r.returnValue) return toast(r.errorText);
        S.lan = r.lanAccess;
        render();
        toast('Local network access ' + (S.lan ? 'on' : 'off') + (isDown() ? '' : ' (takes effect on the next connect)'));
      });
    },
    help: function () { openOverlay('dlgHelp'); },
    profile: function (el) {
      var id = el.getAttribute('data-id');
      if (id === S.selected) return;
      if (!isDown()) { toast('Disconnect first to switch profiles.'); return; }
      luna('select', { id: id }, function (r) { if (!r.returnValue) toast(r.errorText); });
    },
    import: function () { openOverlay('dlgImport'); startImport(); },
    forget: function () {
      var p = selProfile();
      if (!p || !p.saved) { toast('No saved login for this profile.'); return; }
      luna('forgetPassword', { id: p.id }, function (r) { toast(r.returnValue ? 'Saved login removed.' : r.errorText); });
    },
    delete: function () {
      var p = selProfile();
      if (!p) return;
      showMsg('Delete profile?', 'Remove "' + p.name + '" and its saved login from this TV?', [
        { label: 'Delete', fn: function () { luna('deleteProfile', { id: p.id }, function (r) { toast(r.returnValue ? 'Profile deleted.' : r.errorText); }); } },
        { label: 'Cancel' }
      ]);
    },
    tab: function (el) {
      S.tab = el.getAttribute('data-tab');
      $('tabDetails').classList.toggle('on', S.tab === 'details');
      $('tabLog').classList.toggle('on', S.tab === 'log');
      $('details').classList.toggle('hidden', S.tab !== 'details');
      $('log').classList.toggle('hidden', S.tab !== 'log');
      $('infoTitle').textContent = S.tab === 'log' ? 'OpenVPN log' : 'Connection details';
      renderLog();
      renderDetails();
    },
    remember: function () { creds.remember = !creds.remember; $('btnRemember').classList.toggle('on', creds.remember); },
    credsOk: function () {
      var mode = creds.mode, type = creds.type, user = $('inUser').value.trim(), pass = $('inPass').value;
      if (type === 'Auth' && !user) { toast('Enter the username.'); setFocus($('inUser')); return; }
      creds.mode = 'sent';          // closing the dialog now must not count as "cancel"
      closeOverlay('dlgCreds');
      var p = selProfile();
      if (mode === 'connect' && p) connect({ id: p.id, username: user, password: pass, remember: creds.remember });
      else if (mode === 'auth') luna('auth', { type: type, username: user, password: pass }, function (r) { if (!r.returnValue) toast(r.errorText); });
    },
    close: function (el) { closeOverlay(el.closest('.overlay')); },
    msgBtn: function (el) { closeOverlay('dlgMsg'); if (el._fn) el._fn(); },
    usbScan: function () {
      $('usbList').innerHTML = '<p class="dim">Scanning…</p>';
      luna('usbScan', {}, function (r) {
        var box = $('usbList');
        if (!r.returnValue) { box.innerHTML = '<p class="dim">' + esc(r.errorText) + '</p>'; return; }
        if (!r.files.length) { box.innerHTML = '<p class="dim">No .ovpn files found on USB drives.</p>'; return; }
        box.innerHTML = r.files.map(function (f) {
          return '<button class="f" data-act="usbImport" data-path="' + esc(f.path) + '">' + esc(f.name) +
            ' <span class="dim">· ' + esc(f.path.replace(/^\/tmp\/usb\//, 'USB/')) + '</span></button>';
        }).join('');
        setFocus(box.querySelector('.f'));
      });
    },
    usbImport: function (el) {
      luna('usbImport', { path: el.getAttribute('data-path') }, function (r) {
        if (!r.returnValue) { showMsg('Could not add profile', r.errorText); return; }
        imported(r.imported);
      });
    }
  };

  function connect(params) {
    S.userConnect = true;
    luna('connect', params, function (r) {
      if (r.returnValue) return;
      if (r.needCreds) { askCreds('connect'); return; }
      if (r.notRoot) { elevate(); return; }
      toast(r.errorText || 'Could not connect', 5000);
    });
  }

  // ------------------------------------------------------------------ import
  function startImport() {
    if (importSub) { importSub.cancel(); importSub = null; }   // cancelling closes the old session; no separate importStop
    $('impUrl').textContent = '…';
    $('impCode').textContent = '······';
    $('impQr').innerHTML = '';
    importSub = luna('importStart', {}, function (r) {
      if (!r.returnValue) { $('impUrl').textContent = r.errorText || 'Upload page unavailable'; return; }
      if (r.code) {
        var url = (r.urls && r.urls[0]) || ('http://<TV address>:' + r.port + '/');
        $('impUrl').textContent = url.replace(/\/$/, '');
        $('impCode').textContent = r.code;
        try {
          var qr = qrcode(0, 'M');
          qr.addData(url);
          qr.make();
          $('impQr').innerHTML = qr.createImgTag(8, 0);
        } catch (e) { /* no QR */ }
      }
      if (r.imported) imported(r.imported);
      if (r.closed) $('impUrl').textContent = 'Upload page closed. Close and reopen this screen to start again.';
    }, true);
  }
  function stopImport() {
    if (!importSub) return;
    importSub.cancel();
    importSub = null;
    luna('importStop', {});
  }
  function imported(p) {
    var note = p.removed && p.removed.length ? ' Removed for safety: ' + p.removed.join(', ') + '.' : '';
    toast('Added "' + p.name + '".' + note, 6000);
    if (S.profiles.length <= 1 || !S.selected) luna('select', { id: p.id });
  }

  // ------------------------------------------------------------------ status
  function onStatus(r) {
    if (!r.returnValue) {
      if (r.notRoot) { elevate(); return; }
      statusSub = null;
      $('stateText').textContent = 'Service not available';
      $('stateDetail').textContent = r.errorText || '';
      setTimeout(subscribe, 3000);
      return;
    }
    var renderAll = false;
    if (r.status) { S.status = r.status; renderAll = true; }
    if (r.profiles) { S.profiles = r.profiles; S.selected = r.selected; renderAll = true; }
    if (typeof r.keepConnected === 'boolean') { S.keep = r.keepConnected; renderAll = true; }
    if (typeof r.lanAccess === 'boolean') { S.lan = r.lanAccess; renderAll = true; }
    if (r.log && !r.status) { S.log = S.log.concat(r.log).slice(-300); renderLog(); }
    else if (r.log) { S.log = r.log.slice(-300); renderLog(); }
    if (r.logReset) { S.log = r.logReset.slice(-300); renderLog(); }
    if (r.details) { S.status.details = r.details; renderDetails(); }
    if (r.bytes) {
      var now = Date.now(), lb = S.lastBytes;
      if (lb && now > lb.t && r.bytes.in >= lb.in) {
        S.speed = { in: (r.bytes.in - lb.in) * 1000 / (now - lb.t), out: (r.bytes.out - lb.out) * 1000 / (now - lb.t) };
      }
      S.lastBytes = { t: now, in: r.bytes.in, out: r.bytes.out };
      S.status.bytesIn = r.bytes.in; S.status.bytesOut = r.bytes.out;
      renderFacts();
      renderDetails();
    }
    if (renderAll) render();
  }
  function subscribe() {
    if (statusSub) statusSub.cancel();
    statusSub = luna('status', {}, onStatus, true);
  }

  function render() {
    var st = S.status, state = st.state, p = selProfile();
    var dot = $('dot');
    dot.className = 'dot';
    var text, detail = '';
    if (state === 'CONNECTED') { text = 'Connected'; dot.classList.add('connected'); }
    else if (state === 'DISCONNECTED') { text = 'Disconnected'; if (st.error) dot.classList.add('error'); }
    else if (state === 'RECONNECTING') { text = 'Reconnecting…'; detail = st.detail ? 'Reason: ' + st.detail : ''; dot.classList.add('busy'); }
    else if (state === 'EXITING' || state === 'DISCONNECTING') { text = 'Disconnecting…'; dot.classList.add('busy'); }
    else { text = 'Connecting…'; detail = STATE_NAMES[state] || state; dot.classList.add('busy'); }
    $('stateText').textContent = text;
    $('stateDetail').textContent = detail;

    var err = $('errorBox');
    err.textContent = st.error || '';
    err.classList.toggle('hidden', !st.error);

    var btn = $('btnMain');
    btn.textContent = isDown() ? (p ? 'Connect' : 'Add a profile') : 'Disconnect';
    btn.classList.toggle('disconnect', !isDown());
    $('btnKeep').classList.toggle('on', S.keep);
    $('btnLan').classList.toggle('on', S.lan);

    // profiles
    var box = $('profiles');
    var focusId = focused && focused.getAttribute('data-id');
    if (!S.profiles.length) box.innerHTML = '<div class="empty">No profiles yet. Choose “+ Add profile” to load your .ovpn file.</div>';
    else box.innerHTML = S.profiles.map(function (pr) {
      var live = st.profile === pr.id && !isDown();
      return '<button class="f profile' + (pr.id === S.selected ? ' selected' : '') + '" data-act="profile" data-id="' + pr.id + '">' +
        '<span class="radio"></span><span><span class="pname">' + esc(pr.name) + '</span><br><span class="pinfo">' +
        esc(pr.remote || '') + (pr.needsAuth ? (pr.saved ? ' · login saved' : ' · asks for login') : '') + '</span></span>' +
        (live ? '<span class="badge live">in use</span>' : '') + '</button>';
    }).join('');
    if (focusId) { var again = box.querySelector('[data-id="' + focusId + '"]'); if (again) setFocus(again); }
    $('btnForget').classList.toggle('hidden', !(p && p.saved));
    $('btnDelete').classList.toggle('hidden', !p);

    if (st.need && !creds.mode) askCreds('auth', st.need);
    if (S.userConnect && state === 'CONNECTED') S.userConnect = false;
    if (S.userConnect && isDown() && /^Wrong username or password/.test(st.error || '') && !creds.mode) {
      S.userConnect = false;   // the server rejected the login: ask again (username kept, password cleared)
      askCreds('connect');
      $('credsSub').textContent = 'The server rejected the login. Check your username and password.';
    }
    if (isDown()) { S.speed = { in: 0, out: 0 }; S.lastBytes = null; }
    renderFacts();
    renderDetails();
    checkPublicIp();
    ensureFocus($('btnMain'));
  }

  function renderFacts() {
    var st = S.status, p = selProfile(), up = st.state === 'CONNECTED';
    $('fProfile').textContent = st.profileName && !isDown() ? st.profileName : (p ? p.name : '-');
    $('fServer').textContent = up && st.remoteIp ? st.remoteIp : (p && p.remote ? p.remote : '-');
    $('fVpnIp').textContent = up ? (st.localIp || '-') : '-';
    $('fPublicIp').textContent = S.publicIp || '-';
    $('fTime').textContent = up && st.since ? fmtDur(Date.now() - st.since) : '-';
    $('fBytes').textContent = !isDown() ? '↓ ' + fmtBytes(st.bytesIn) + '   ↑ ' + fmtBytes(st.bytesOut) : '-';
  }

  function renderLog() {
    if (S.tab !== 'log') return;
    $('log').textContent = S.log.slice(-40).join('\n');
  }

  function cn(subject) {
    var m = /(?:^|,\s*)CN=([^,]+)/.exec(subject || '');
    return m ? m[1] : (subject || '');
  }
  function maskBits(mask) {
    var p = String(mask || '').split('.');
    if (p.length !== 4) return '';
    var n = 0;
    p.forEach(function (o) { var v = +o; while (v) { n += v & 1; v >>= 1; } });
    return '/' + n;
  }
  function fmtRate(bps) { return fmtBytes(Math.round(bps)) + '/s'; }

  function renderDetails() {
    if (S.tab !== 'details') return;
    var st = S.status, d = st.details || {}, box = $('details');
    if (isDown() && !d.server) {
      box.innerHTML = '<div class="empty">' + (st.error ? 'Last attempt failed: ' + esc(st.error) :
        'Connect to see the details of the VPN connection: server, encryption, addresses, routes, DNS and traffic.') + '</div>';
      return;
    }
    var up = st.state === 'CONNECTED';
    var routing = d.redirect ? 'All traffic' + (S.lan ? ', LAN stays local' : '') :
      (d.routes && d.routes.length ? 'Split tunnel' : (d.completed ? 'VPN network only' : ''));
    var groups = [
      ['Server', [
        ['Status', up ? '' : $('stateText').textContent + ($('stateDetail').textContent ? ' · ' + $('stateDetail').textContent : '')],
        ['Address', d.server ? d.server + (d.port ? ':' + d.port : '') : ''],
        ['Protocol', d.protocol || ''],
        ['Certificate', cn(d.serverCert)],
        ['Issued by', cn(d.serverCa) !== cn(d.serverCert) ? cn(d.serverCa) : ''],
        ['Reconnects', String(st.reconnects || 0)]
      ]],
      ['Security', [
        ['Control channel', d.tls ? d.tls : ''],
        ['TLS cipher', d.tlsCipher || ''],
        ['Key exchange', d.keyAgreement || ''],
        ['Server key', d.peerKey || ''],
        ['Data cipher', d.dataCipher || d.pushedCipher || ''],
        ['Compression', d.compression || ''],
        ['OpenVPN', d.openvpn || '']
      ]],
      ['Network', [
        ['Interface', d.iface || ''],
        ['VPN address', d.vpnIp ? d.vpnIp + maskBits(d.netmask) : (st.localIp || '')],
        ['IPv6 address', d.vpnIp6 || ''],
        ['VPN gateway', d.gateway || ''],
        ['Routing', routing],
        ['Extra routes', d.routes && d.routes.length ? d.routes.join(', ') : ''],
        ['MTU', d.mtu || ''],
        ['Keepalive', d.ping ? d.ping + ' s / timeout ' + (d.pingRestart || '?') + ' s' : '']
      ]],
      ['DNS & traffic', [
        ['Pushed DNS', d.dns && d.dns.length ? d.dns.join(', ') : (d.completed ? 'none' : '')],
        ['DNS domain', d.domain || ''],
        ['Download', up ? fmtRate(S.speed.in) : ''],
        ['Upload', up ? fmtRate(S.speed.out) : ''],
        ['Received', fmtBytes(st.bytesIn)],
        ['Sent', fmtBytes(st.bytesOut)]
      ]]
    ];
    box.innerHTML = groups.map(function (g) {
      var rows = g[1].filter(function (r) { return r[1]; });
      if (!rows.length) return '';
      return '<div class="grp"><h4>' + esc(g[0]) + '</h4><div class="kv">' + rows.map(function (r) {
        return '<span class="k">' + esc(r[0]) + '</span><span class="v' + (r[2] ? ' ' + r[2] : '') + '">' + esc(r[1]) + '</span>';
      }).join('') + '</div></div>';
    }).join('');
  }

  function checkPublicIp() {
    var st = S.status, key = st.state === 'CONNECTED' ? 'up:' + st.since : st.state === 'DISCONNECTED' ? 'down' : null;
    if (!key || key === S.ipKey) return;
    S.ipKey = key;
    S.publicIp = 'checking…';
    $('fPublicIp').textContent = S.publicIp;
    var x = new XMLHttpRequest();
    x.open('GET', 'https://api.ipify.org?format=json');
    x.timeout = 10000;
    x.onload = function () {
      if (S.ipKey !== key) return;
      try { S.publicIp = JSON.parse(x.responseText).ip; } catch (e) { S.publicIp = '-'; }
      $('fPublicIp').textContent = S.publicIp;
      renderDetails();
    };
    x.onerror = x.ontimeout = function () { if (S.ipKey === key) { S.publicIp = 'unavailable'; $('fPublicIp').textContent = S.publicIp; } };
    x.send();
  }

  // ------------------------------------------------------------------ start-up: root check, elevation
  function elevate() {
    if (elevatedOnce) {
      showMsg('Root access needed', 'The service could not get root access. Restart the TV and open the app again.');
      return;
    }
    elevatedOnce = true;
    $('stateText').textContent = 'Setting up…';
    $('stateDetail').textContent = 'Getting root access through Homebrew Channel';
    luna('luna://org.webosbrew.hbchannel.service/exec', { command: ELEVATE }, function (r) {
      if (!r.returnValue) {
        showMsg('Rooted TV needed', 'This app needs a rooted LG TV with Homebrew Channel, because a VPN changes the TV\'s network settings.' +
          (r.errorText ? '\n\n(' + r.errorText + ')' : ''));
        $('stateText').textContent = 'Root access needed';
        return;
      }
      luna('quit', {}, function () { setTimeout(start, 1500); });
    });
  }

  function start() {
    luna('getInfo', {}, function (r) {
      if (!r.returnValue) {
        $('stateText').textContent = 'Service not available';
        $('stateDetail').textContent = r.errorText || '';
        return;
      }
      if (!r.root) { elevate(); return; }
      if (!r.tun) showMsg('No VPN support', 'This TV has no /dev/net/tun device, so it cannot run a VPN.');
      subscribe();
    });
  }

  setInterval(function () { if (S.status.state === 'CONNECTED') $('fTime').textContent = S.status.since ? fmtDur(Date.now() - S.status.since) : '-'; }, 1000);
  document.addEventListener('webOSRelaunch', function () { if (!statusSub) start(); });
  render();
  start();
})();
