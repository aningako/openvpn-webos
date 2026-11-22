#!/usr/bin/env python3
"""TV-free UI check + README screenshots: runs the app in headless Chromium (1920x1080) with tools/demo/mock-bridge.js.
Usage: python3 tools/demo/shoot.py [outdir]   (default docs/) -> screenshot PNGs, prints JS errors if any."""
import base64, json, os, subprocess, sys, tempfile, time, urllib.request
import websocket

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'docs')
APP = 'file://' + os.path.join(ROOT, 'app', 'com.homebrew.openvpn', 'index.html')
MOCK = open(os.path.join(ROOT, 'tools', 'demo', 'mock-bridge.js')).read()
PORT = 9334

prof = tempfile.mkdtemp(prefix='ovpn-chrome-')
chrome = subprocess.Popen(['chromium', '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
                           '--remote-debugging-port=%d' % PORT, '--user-data-dir=' + prof, '--window-size=1920,1080',
                           '--allow-file-access-from-files', 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try:
            pages = json.load(urllib.request.urlopen('http://127.0.0.1:%d/json' % PORT, timeout=2)); break
        except Exception:
            time.sleep(0.2)
    ws = websocket.create_connection([p for p in pages if p['type'] == 'page'][0]['webSocketDebuggerUrl'], timeout=30, suppress_origin=True)
    n = [0]; errors = []

    def call(method, **params):
        n[0] += 1
        ws.send(json.dumps({'id': n[0], 'method': method, 'params': params}))
        while True:
            m = json.loads(ws.recv())
            if m.get('method') == 'Runtime.exceptionThrown':
                errors.append(m['params']['exceptionDetails'].get('exception', {}).get('description', 'error'))
            if m.get('id') == n[0]:
                return m.get('result')

    def js(expr):
        return call('Runtime.evaluate', expression=expr, returnByValue=True)['result'].get('value')

    def key(code):
        for t in ('rawKeyDown', 'keyUp'):
            call('Input.dispatchKeyEvent', type=t, windowsVirtualKeyCode=code, nativeVirtualKeyCode=code)

    def shot(name):
        time.sleep(0.4)
        data = call('Page.captureScreenshot', format='png')['data']
        open(os.path.join(OUT, name), 'wb').write(base64.b64decode(data))
        print('wrote', name)

    call('Runtime.enable'); call('Page.enable')
    call('Emulation.setDeviceMetricsOverride', width=1920, height=1080, deviceScaleFactor=1, mobile=False)
    call('Page.addScriptToEvaluateOnNewDocument', source=MOCK)
    os.makedirs(OUT, exist_ok=True)

    call('Page.navigate', url=APP + '#connected'); time.sleep(1.5)
    assert js('document.getElementById("stateText").textContent') == 'Connected'
    assert js('document.getElementById("details").scrollHeight <= document.getElementById("details").clientHeight + 2'), \
        'details overflow ' + js('document.getElementById("details").scrollHeight + "/" + document.getElementById("details").clientHeight')
    shot('screenshot-connected.png')
    # keyboard navigation reaches every control on the main screen
    seen = set()
    for k in [40, 40, 40, 39, 38, 38, 38, 39, 37, 40, 40, 39, 39]:
        key(k); seen.add(js('(document.querySelector(".focus")||{}).getAttribute ? document.querySelector(".focus").getAttribute("data-act") : null'))
    print('focus visited:', sorted(x for x in seen if x))
    key(461); time.sleep(0.2)
    assert 'stays connected' in js('document.getElementById("toast").textContent'), 'Back while connected must not exit'
    js('document.querySelector("[data-act=import]").click()'); time.sleep(0.6)
    js('document.querySelector("[data-act=usbScan]").click()'); time.sleep(0.4)
    shot('screenshot-import.png')
    key(461); time.sleep(0.3)
    assert js('document.getElementById("dlgImport").classList.contains("hidden")')
    js('document.getElementById("btnHelp").click()'); shot('screenshot-help.png'); key(461)

    call('Page.navigate', url='about:blank'); time.sleep(0.3)
    call('Page.navigate', url=APP + '#disconnected'); time.sleep(1.5)
    js('document.querySelector("[data-id=b1b2c3d4e5f60718]").click()')   # select 'Office' (no saved login) -> mock keeps selection
    time.sleep(0.3)
    js('document.getElementById("btnMain").click()'); time.sleep(0.6)
    assert js('!document.getElementById("dlgCreds").classList.contains("hidden")'), 'login dialog should open for a profile without saved login'
    shot('screenshot-login.png')
    key(461); time.sleep(0.3)
    assert js('document.getElementById("dlgCreds").classList.contains("hidden")'), 'Back closes the dialog'
    key(461); time.sleep(0.2)
    assert 'Back again' in js('document.getElementById("toast").textContent')

    call('Page.navigate', url='about:blank'); time.sleep(0.3)
    call('Page.navigate', url=APP + '#empty'); time.sleep(1.5)
    assert js('document.getElementById("btnMain").textContent') == 'Add a profile'
    print('JS errors:', errors or 'none')
    sys.exit(1 if errors else 0)
finally:
    chrome.kill()
