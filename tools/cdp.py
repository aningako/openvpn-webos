#!/usr/bin/env python3
"""Tiny CDP helper for the TV web inspector.
usage: TV_INSPECTOR=<tv-ip>:9998 cdp.py eval '<js expression>'      (evaluated in the app page, awaits promises)
       cdp.py shot out.png                 (screenshot)
       cdp.py key <keyCode> [<keyCode>...] (dispatch real key events via Input domain)
"""
import base64, json, os, sys, urllib.request
import websocket

TV = os.environ.get('TV_INSPECTOR') or sys.exit('set TV_INSPECTOR=<tv-ip>:9998')
APP = os.environ.get('APP', 'com.homebrew.openvpn')


def page_ws():
    pages = json.load(urllib.request.urlopen('http://%s/json' % TV, timeout=10))
    for p in pages:
        if p.get('description') == APP and p.get('type') == 'page':
            return p['webSocketDebuggerUrl']
    sys.exit('app page not found')


class CDP:
    def __init__(self):
        self.ws = websocket.create_connection(page_ws(), timeout=60, suppress_origin=True)
        self.n = 0

    def call(self, method, **params):
        self.n += 1
        self.ws.send(json.dumps({'id': self.n, 'method': method, 'params': params}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get('id') == self.n:
                if 'error' in m:
                    raise RuntimeError(m['error'])
                return m['result']


def main():
    c = CDP()
    cmd = sys.argv[1]
    if cmd == 'eval':
        r = c.call('Runtime.evaluate', expression=sys.argv[2], awaitPromise=True, returnByValue=True)
        if 'exceptionDetails' in r:
            print('EXCEPTION', json.dumps(r['exceptionDetails'], indent=1)[:2000])
        else:
            v = r['result'].get('value')
            print(v if isinstance(v, str) else json.dumps(v, indent=1))
    elif cmd == 'shot':
        r = c.call('Page.captureScreenshot', format='png')
        open(sys.argv[2], 'wb').write(base64.b64decode(r['data']))
        print(sys.argv[2])
    elif cmd == 'key':
        names = {37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 13: 'Enter'}
        for kc in map(int, sys.argv[2:]):
            for t in ('rawKeyDown', 'keyUp'):
                c.call('Input.dispatchKeyEvent', type=t, windowsVirtualKeyCode=kc, nativeVirtualKeyCode=kc,
                       key=names.get(kc, ''), code=names.get(kc, ''))
        print('sent')


if __name__ == '__main__':
    main()
