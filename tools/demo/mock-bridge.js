// Fake PalmServiceBridge for TV-free UI tests and README screenshots. Uses documentation-only addresses
// (RFC 5737 / example.com), never a real profile. Scenario via location.hash: #connected (default), #empty, #disconnected.
(function () {
  var scen = (location.hash || '#connected').slice(1);
  var now = Date.now();
  var profiles = scen === 'empty' ? [] : [
    { id: 'a1b2c3d4e5f60718', name: 'Home VPN', remote: 'vpn.example.com:1194', needsAuth: true, saved: true, removed: [], created: 1 },
    { id: 'b1b2c3d4e5f60718', name: 'Office', remote: '198.51.100.20:443', needsAuth: true, saved: false, removed: [], created: 2 }
  ];
  var details = {
    openvpn: '2.7.7', protocol: 'UDPv4', server: '203.0.113.10', port: '1194', serverCert: 'CN=vpn.example.com, O=Example',
    serverCa: 'CN=Example VPN CA, O=Example', tls: 'TLSv1.3', tlsCipher: 'TLS_AES_256_GCM_SHA384', keyAgreement: 'X25519MLKEM768',
    peerKey: '2048 bits RSA', dataCipher: 'AES-256-GCM', iface: 'tun0', vpnIp: '10.8.0.6', netmask: '255.255.255.0',
    gateway: '10.8.0.1', redirect: 'def1', routes: [], mtu: '1500', ping: '10', pingRestart: '60', dns: ['10.8.0.1'],
    domain: 'example.lan', completed: true
  };
  var up = scen === 'connected';
  var status = up ? { state: 'CONNECTED', detail: 'SUCCESS', localIp: '10.8.0.6', remoteIp: '203.0.113.10', since: now - 754000,
    bytesIn: 48230000, bytesOut: 5120000, profile: profiles[0].id, profileName: 'Home VPN', error: '', need: null, details: details, reconnects: 0 }
    : { state: 'DISCONNECTED', detail: '', since: 0, bytesIn: 0, bytesOut: 0, profile: null, profileName: '', error: '', need: null, details: {}, reconnects: 0 };
  var log = ['18:02:11 OpenVPN 2.7.7 armv7-alpine-linux-musleabihf', '18:02:11 UDPv4 link remote: [AF_INET]203.0.113.10:1194',
    '18:02:12 VERIFY OK: depth=0, CN=vpn.example.com', '18:02:12 Control Channel: TLSv1.3, cipher TLSv1.3 TLS_AES_256_GCM_SHA384',
    '18:02:13 TUN/TAP device tun0 opened', '18:02:13 Initialization Sequence Completed'];
  var subs = [];
  function B() {}
  B.prototype.call = function (uri, params) {
    var self = this, m = uri.split('/').pop(), p = JSON.parse(params);
    window.__calls = (window.__calls || []).concat([{ m: m, p: p }]);
    var reply = function (o) { setTimeout(function () { if (self.onservicecallback) self.onservicecallback(JSON.stringify(o)); }, 30); };
    if (m === 'getInfo') return reply({ returnValue: true, root: true, tun: true, uid: 0, version: '1.0.0' });
    if (m === 'status') { subs.push(self); return reply({ returnValue: true, subscribed: true, status: status, log: log, profiles: profiles, selected: profiles[0] ? profiles[0].id : null, keepConnected: true, lanAccess: true }); }
    if (m === 'select') {
      subs.forEach(function (s) { setTimeout(function () { s.onservicecallback(JSON.stringify({ returnValue: true, subscribed: true, profiles: profiles, selected: p.id })); }, 10); });
      return reply({ returnValue: true });
    }
    if (m === 'importStart') return reply({ returnValue: true, subscribed: true, code: '482915', port: 8899, urls: ['http://192.168.1.50:8899/'] });
    if (m === 'usbScan') return reply({ returnValue: true, files: [{ path: '/tmp/usb/sda/sda1/vpn/home.ovpn', name: 'home.ovpn', size: 4096 }] });
    if (m === 'connect' && !p.username && profiles.length && p.id === profiles[1].id) return reply({ returnValue: false, needCreds: true, errorText: 'Username and password needed.' });
    reply({ returnValue: true });
  };
  B.prototype.cancel = function () {};
  window.PalmServiceBridge = B;
  // stable public IP for screenshots
  var X = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    var x = { open: function () {}, send: function () { setTimeout(function () { x.responseText = JSON.stringify({ ip: up ? '203.0.113.10' : '192.0.2.44' }); if (x.onload) x.onload(); }, 50); } };
    return x;
  };
  window.XMLHttpRequest.real = X;
})();
