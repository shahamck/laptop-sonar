#!/usr/bin/env python3
"""Laptop Sonar bridge: turns gestures from the sonar page into key presses on this Mac.

    python3 bridge.py            # listens on 127.0.0.1:8650

Only accepts the five gesture names below and only from the origins in ALLOWED_ORIGINS,
and only presses the fixed keys in KEYS, so a web page can't make it run anything else.
macOS asks to allow your terminal under Privacy & Security > Accessibility the first time.
"""

import json
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT = "127.0.0.1", 8650

# Gesture -> (macOS key code, modifiers). Change these to remap.
# Key codes: 123 left, 124 right, 125 down, 126 up, 49 space, 24 "=", 27 "-".
KEYS = {
    "swipe-left":  (124, []),               # right arrow: next slide
    "swipe-right": (123, []),               # left arrow: previous slide
    "tap":         (49,  []),               # space: play / pause
    "push":        (24,  ["command"]),      # cmd + = : zoom in
    "pull":        (27,  ["command"]),      # cmd + - : zoom out
}

# Pages allowed to send gestures. Add your deployed URL here (scheme + host, no path).
ALLOWED_ORIGINS = {
    "http://localhost:8644",
    "http://127.0.0.1:8644",
}


def press(code, mods):
    using = ""
    if mods:
        using = " using {" + ", ".join(f"{m} down" for m in mods) + "}"
    script = f'tell application "System Events" to key code {int(code)}{using}'
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if r.returncode != 0:
        msg = r.stderr.strip()
        print(f"  ! osascript failed: {msg}", file=sys.stderr)
        if "not allowed" in msg or "1002" in msg or "assistive" in msg:
            print("  ! Allow your terminal app in System Settings > Privacy & Security > Accessibility.",
                  file=sys.stderr)
        return False
    return True


class Handler(BaseHTTPRequestHandler):
    def _origin_ok(self):
        origin = self.headers.get("Origin")
        return origin is None or origin in ALLOWED_ORIGINS

    def _cors(self):
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            # Lets an HTTPS page talk to this local server (Chrome's Private Network Access).
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def _reply(self, status, body=None):
        data = b"" if status == 204 else json.dumps(body or {}).encode()
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._reply(204 if self._origin_ok() else 403)

    def do_GET(self):
        if not self._origin_ok():
            return self._reply(403, {"error": "origin not allowed"})
        if self.path.split("?")[0] == "/ping":
            return self._reply(200, {"ok": True, "gestures": list(KEYS)})
        self._reply(404, {"error": "not found"})

    def do_POST(self):
        if not self._origin_ok():
            return self._reply(403, {"error": "origin not allowed"})
        if self.path != "/gesture":
            return self._reply(404, {"error": "not found"})
        try:
            length = min(int(self.headers.get("Content-Length", 0)), 1024)
            gesture = json.loads(self.rfile.read(length) or b"{}").get("gesture")
        except (ValueError, AttributeError):
            return self._reply(400, {"error": "bad json"})
        if gesture not in KEYS:
            return self._reply(400, {"error": "unknown gesture"})
        print(f"  {gesture}")
        ok = press(*KEYS[gesture])
        self._reply(200 if ok else 500, {"ok": ok, "gesture": gesture})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"Laptop Sonar bridge on http://{HOST}:{PORT}  (Ctrl+C to stop)")
    print("Allowed pages: " + ", ".join(sorted(ALLOWED_ORIGINS)))
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
