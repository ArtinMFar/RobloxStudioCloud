#!/usr/bin/env python3
"""Streams the virtual display Roblox Studio runs on to a browser, and plays the
browser's keyboard, mouse and touch input back into it.

Runs on the Colab VM as root, next to Xvfb and Wine. vm/setup.py starts it and
puts a Cloudflare quick tunnel in front of it.

Video, two ways, each only while someone watches it:

- h264 (the default): ffmpeg grabs the display with MIT-SHM and the GPU encodes
  it (h264_nvenc, the NVIDIA encoder; libx264 if NVENC will not start). The
  stream is cut into access units here and each one goes to the page as one
  websocket message, which the browser hands to its own hardware decoder
  (WebCodecs). 60 fps, no B-frames, so nothing waits for a later frame.
- mpeg1: the same picture as MPEG-1 in MPEG-TS for JSMpeg, a decoder written in
  JavaScript, for browsers without WebCodecs. 30 fps.

Sound (optional) is a separate MP2 stream for JSMpeg, from PulseAudio.

Input arrives on /ctl as small JSON messages and goes into X through XTest, the
way a real keyboard and mouse would; Wine passes it on to Studio. The pointer's
shape is sent back to the page (XFixes), so the page shows Studio's own cursor
with no stream delay.

Every websocket requires ?k=<session key>; only its SHA-256 is known here.
"""

import argparse
import asyncio
import base64
import hashlib
import hmac
import json
import os
import shlex
import signal
import struct
import subprocess
import sys
import time
import zlib

from aiohttp import WSMsgType, web
from Xlib import X, XK
from Xlib import display as xdisplay
from Xlib import error as xerror
from Xlib.ext import xtest

# Browser KeyboardEvent.code -> X keysym name. Physical keys, so WASD stays WASD
# on any keyboard layout.
KEYS = {
    "Space": "space", "Enter": "Return", "NumpadEnter": "KP_Enter", "Escape": "Escape",
    "Backspace": "BackSpace", "Tab": "Tab", "Delete": "Delete", "Insert": "Insert",
    "Home": "Home", "End": "End", "PageUp": "Prior", "PageDown": "Next",
    "ArrowUp": "Up", "ArrowDown": "Down", "ArrowLeft": "Left", "ArrowRight": "Right",
    "ShiftLeft": "Shift_L", "ShiftRight": "Shift_R", "ControlLeft": "Control_L",
    "ControlRight": "Control_R", "AltLeft": "Alt_L", "AltRight": "Alt_R",
    "MetaLeft": "Super_L", "MetaRight": "Super_R", "ContextMenu": "Menu",
    "CapsLock": "Caps_Lock", "Minus": "minus", "Equal": "equal",
    "BracketLeft": "bracketleft", "BracketRight": "bracketright", "Backslash": "backslash",
    "Semicolon": "semicolon", "Quote": "apostrophe", "Backquote": "grave", "Comma": "comma",
    "Period": "period", "Slash": "slash", "IntlBackslash": "less",
    "NumpadAdd": "KP_Add", "NumpadSubtract": "KP_Subtract", "NumpadMultiply": "KP_Multiply",
    "NumpadDivide": "KP_Divide", "NumpadDecimal": "KP_Decimal",
}
KEYS.update({f"Key{c}": c.lower() for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"})
KEYS.update({f"Digit{d}": str(d) for d in range(10)})
KEYS.update({f"Numpad{d}": f"KP_{d}" for d in range(10)})
KEYS.update({f"F{n}": f"F{n}" for n in range(1, 13)})


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def png(width, height, rgba):
    """A minimal RGBA PNG (for cursor images), without any imaging library."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    rows = b"".join(b"\0" + rgba[y * width * 4:(y + 1) * width * 4] for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 6)) + chunk(b"IEND", b""))


class Screen:
    """The X display: keyboard and mouse in, pointer shape out."""

    def __init__(self, name, width, height):
        self.name = name
        self.d = xdisplay.Display(name)
        self.root = self.d.screen().root
        self.w, self.h = width, height
        self.held_keys = set()
        self.held_buttons = set()
        self.cursor_d = xdisplay.Display(name)  # a second connection, polled for the pointer shape
        self.has_xfixes = self.cursor_d.has_extension("XFIXES")
        if self.has_xfixes:
            self.cursor_d.xfixes_query_version()
        self.cursor_serial = None
        self.maximise_tries = {}  # Studio window id -> (tries, last try)

    def sync(self):
        self.d.sync()

    def move(self, x, y):
        xtest.fake_input(self.d, X.MotionNotify, x=int(x), y=int(y))
        self.sync()

    def move_rel(self, dx, dy):
        # python-xlib: detail=True makes MotionNotify relative.
        xtest.fake_input(self.d, X.MotionNotify, detail=True, x=int(dx), y=int(dy))
        self.sync()

    def button(self, b, down):
        if down:
            self.held_buttons.add(b)
        elif b not in self.held_buttons:
            return
        else:
            self.held_buttons.discard(b)
        xtest.fake_input(self.d, X.ButtonPress if down else X.ButtonRelease, b)
        self.sync()

    def wheel(self, dx, dy):
        for delta, neg, pos in ((dy, 4, 5), (dx, 6, 7)):
            if not delta:
                continue
            b = neg if delta < 0 else pos
            for _ in range(min(10, max(1, round(abs(delta) / 100)))):
                xtest.fake_input(self.d, X.ButtonPress, b)
                xtest.fake_input(self.d, X.ButtonRelease, b)
        self.sync()

    def keycode(self, code):
        name = KEYS.get(code)
        return self.d.keysym_to_keycode(XK.string_to_keysym(name)) if name else 0

    def key(self, code, down):
        kc = self.keycode(code)
        if not kc:
            return
        if down:
            self.held_keys.add(kc)
        elif kc not in self.held_keys:
            return  # a release for a press that never reached X
        else:
            self.held_keys.discard(kc)
        xtest.fake_input(self.d, X.KeyPress if down else X.KeyRelease, kc)
        self.sync()

    def tap(self, code, mods=()):
        for m in mods:
            self.key(m, True)
        self.key(code, True)
        self.key(code, False)
        for m in reversed(mods):
            self.key(m, False)

    def release_all(self):
        for kc in list(self.held_keys):
            xtest.fake_input(self.d, X.KeyRelease, kc)
        for b in list(self.held_buttons):
            xtest.fake_input(self.d, X.ButtonRelease, b)
        self.held_keys.clear()
        self.held_buttons.clear()
        self.sync()

    def set_clipboard(self, text):
        """Put text on the X clipboard; Wine hands it to Studio on Ctrl+V."""
        subprocess.Popen(["xclip", "-selection", "clipboard", "-i"], stdin=subprocess.PIPE,
                         env={**os.environ, "DISPLAY": self.name}, start_new_session=True).communicate(
            text.encode(), timeout=5)

    def get_clipboard(self):
        r = subprocess.run(["xclip", "-selection", "clipboard", "-o", "-t", "UTF8_STRING"], capture_output=True,
                           env={**os.environ, "DISPLAY": self.name}, timeout=5)
        return r.stdout.decode(errors="replace") if r.returncode == 0 else ""

    def ctrl_held(self):
        return self.keycode("ControlLeft") in self.held_keys or self.keycode("ControlRight") in self.held_keys

    def type_text(self, text):
        # xdotool maps characters that are not on the keymap (accents, symbols) itself.
        subprocess.run(["xdotool", "type", "--delay", "8", "--", text],
                       env={**os.environ, "DISPLAY": self.name}, timeout=30)

    def maximise_studio(self):
        """Maximise Studio's main window inside Wine's virtual desktop, once per window.

        Wine draws the window frame itself here, so a double-click on the title
        bar is what maximises it (an X-side resize would not reach Windows)."""
        for desk in self.root.query_tree().children:
            try:
                kids = desk.query_tree().children
            except xerror.XError:
                continue
            for win in kids:
                try:
                    name = win.get_wm_name() or ""
                    cls = win.get_wm_class() or ()
                    if not name.endswith("Roblox Studio") or "robloxstudiobeta.exe" not in cls:
                        continue
                    if win.get_attributes().map_state != X.IsViewable:
                        continue
                    g = win.get_geometry()
                except xerror.XError:
                    continue
                if g.width < 600 or (g.x <= 0 and g.y <= 0 and g.width >= self.w and g.height >= self.h):
                    continue  # a small dialog, or already maximised
                tries, last = self.maximise_tries.get(win.id, (0, 0.0))
                if tries >= 3 or time.monotonic() - last < 2:
                    continue
                self.maximise_tries[win.id] = (tries + 1, time.monotonic())
                p = self.root.query_pointer()
                x, y = g.x + g.width // 2, g.y + 12
                log(f"maximising Studio's window 0x{win.id:x} ({g.width}x{g.height}+{g.x}+{g.y})")
                xtest.fake_input(self.d, X.MotionNotify, x=x, y=y)
                for _ in range(2):
                    xtest.fake_input(self.d, X.ButtonPress, 1)
                    xtest.fake_input(self.d, X.ButtonRelease, 1)
                    self.d.sync()
                    time.sleep(0.08)
                xtest.fake_input(self.d, X.MotionNotify, x=p.root_x, y=p.root_y)
                self.sync()

    def cursor(self):
        """The pointer's image as a message for the page, or None if it has not changed."""
        if not self.has_xfixes:
            return None
        img = self.cursor_d.xfixes_get_cursor_image(self.root)
        if img.cursor_serial == self.cursor_serial:
            return None
        self.cursor_serial = img.cursor_serial
        w, h = img.width, img.height
        px = img.cursor_image
        if not w or not h or not any(p >> 24 for p in px):
            return {"t": "cursor", "hidden": True}
        out = bytearray(w * h * 4)
        for i, p in enumerate(px):  # premultiplied ARGB -> straight RGBA
            a = (p >> 24) & 255
            if a:
                r, g, b = (p >> 16) & 255, (p >> 8) & 255, p & 255
                if a < 255:
                    r, g, b = min(255, r * 255 // a), min(255, g * 255 // a), min(255, b * 255 // a)
                out[i * 4:i * 4 + 4] = bytes((r, g, b, a))
        return {"t": "cursor", "png": base64.b64encode(png(w, h, bytes(out))).decode(),
                "hx": img.xhot, "hy": img.yhot, "w": w, "h": h}


class Encoder:
    """One ffmpeg for one kind of stream, running only while someone watches it."""

    def __init__(self, cfg, kind):
        self.cfg = cfg
        self.kind = kind  # "h264", "mpeg1" or "audio"
        self.viewers = set()
        self.proc = None
        self.task = None
        self.restart_at = 0.0
        self.frames = 0
        self.nvenc = cfg.get("nvenc", True)

    def command(self):
        c = self.cfg
        base = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"]
        if self.kind == "audio":
            return base + ["-f", "pulse", "-fragment_size", "1024", "-i", c.get("audio_source") or "default",
                           "-f", "mpegts", "-c:a", "mp2", "-b:a", "128k", "-ar", "44100", "-ac", "2",
                           "-flush_packets", "1", "-muxdelay", "0.001", "pipe:1"]
        w, h = c["width"], c["height"]
        fps = c["fps"] if self.kind == "h264" else min(30, c["fps"])
        grab = ["-f", "x11grab", "-draw_mouse", "0", "-framerate", str(fps), "-video_size", f"{w}x{h}",
                "-i", f"{c['display']}.0+0,0"]
        if self.kind == "mpeg1":
            br = min(c["bitrate"], 5000)
            return base + grab + ["-f", "mpegts", "-c:v", "mpeg1video", "-b:v", f"{br}k", "-maxrate", f"{br}k",
                                  "-bufsize", f"{br // 2}k", "-g", str(fps), "-bf", "0",
                                  "-flush_packets", "1", "-muxdelay", "0.001", "pipe:1"]
        br = c["bitrate"]
        if self.nvenc:
            # NVENC takes the grabbed BGRx frames as they are and converts them on the GPU.
            # Quality-targeted VBR: a still screen costs ~200 kbit/s, motion is capped at the bitrate.
            enc = ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "ll", "-zerolatency", "1", "-delay", "0",
                   "-rc", "vbr", "-cq", "23", "-b:v", "0", "-maxrate", f"{br}k", "-bufsize", f"{br // 2}k",
                   "-profile:v", "high", "-g", str(fps * 10), "-bf", "0", "-forced-idr", "1", "-aud", "1"]
        else:
            enc = ["-vf", "format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
                   "-crf", "25", "-maxrate", f"{br}k", "-bufsize", f"{br // 2}k", "-profile:v", "high",
                   "-g", str(fps * 10), "-bf", "0", "-x264-params", "aud=1:threads=2"]
        return base + grab + enc + ["-f", "h264", "-flush_packets", "1", "pipe:1"]

    def add(self, q):
        self.viewers.add(q)
        if self.kind == "h264":
            self.keyframe()  # a new viewer needs a keyframe now, not at the end of the GOP
        if not self.task or self.task.done():
            self.task = asyncio.get_running_loop().create_task(self.run())

    def remove(self, q):
        self.viewers.discard(q)
        if not self.viewers:
            self.kill()  # run() sees nobody left and ends

    def keyframe(self):
        """ffmpeg cannot be asked for an IDR from outside, so start it again: the
        first frame of a new encoder is one. Costs a few hundred milliseconds."""
        now = time.monotonic()
        if self.proc and self.proc.returncode is None and now - self.restart_at > 1.0:
            self.restart_at = now
            self.kill()

    def kill(self):
        if self.proc and self.proc.returncode is None:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def publish(self, data, key):
        for q in list(self.viewers):
            q.put_nowait((data, key))

    async def run(self):
        failures = 0
        while self.viewers:
            started = time.monotonic()
            cmd = self.command()
            log(f"{self.kind}: {shlex.join(cmd)}")
            self.proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True)
            err_task = asyncio.create_task(self.proc.stderr.read())
            try:
                if self.kind == "h264":
                    await self.pump_h264()
                else:
                    while chunk := await self.proc.stdout.read(65536):
                        self.publish(chunk, False)
            finally:
                self.kill()
                await self.proc.wait()
            err = (await err_task).decode(errors="replace").strip()
            if err:
                log(f"{self.kind} ffmpeg: {err[-600:]}")
            quick = time.monotonic() - started < 3
            if quick and self.kind == "h264" and self.nvenc and self.frames == 0:
                log("h264: NVENC did not start; using libx264 on the CPU")
                self.nvenc = False
                continue
            failures = failures + 1 if quick and time.monotonic() - self.restart_at > 2 else 0
            await asyncio.sleep(min(5, 0.3 * failures))
        log(f"{self.kind}: nobody watching, encoder stopped")

    async def pump_h264(self):
        """Cut the Annex-B byte stream into access units at each access unit
        delimiter (NAL type 9) and publish one message per frame."""
        buf = bytearray()
        aud = b"\x00\x00\x01\x09"
        while chunk := await self.proc.stdout.read(262144):
            buf += chunk
            while True:
                i = buf.find(aud, 4)
                if i < 0:
                    break
                start = i - 1 if buf[i - 1] == 0 else i  # 4-byte start code
                au = bytes(buf[:start])
                del buf[:start]
                self.frames += 1
                self.publish(au, is_idr(au))
                if len(buf) < 5:
                    break


def is_idr(au):
    i = 0
    while True:
        i = au.find(b"\x00\x00\x01", i)
        if i < 0 or i + 3 >= len(au):
            return False
        if au[i + 3] & 0x1F == 5:
            return True
        i += 3


class Streamer:
    def __init__(self, cfg):
        self.cfg = cfg
        self.key_hash = cfg["key_hash"]
        self.screen = Screen(cfg["display"], cfg["width"], cfg["height"])
        self.encoders = {k: Encoder(cfg, k) for k in ("h264", "mpeg1", "audio")}
        self.ctl_clients = set()
        self.last_client = time.time()
        self.stopped = False
        self.restarting = False
        self.last_cursor = None

    # ---------------------------------------------------------------- auth
    def authorised(self, request):
        k = request.query.get("k", "")
        return bool(k) and hmac.compare_digest(hashlib.sha256(k.encode()).hexdigest(), self.key_hash)

    def studio_running(self):
        return subprocess.run(["pgrep", "-f", "RobloxStudioBeta"], capture_output=True).returncode == 0

    def state(self):
        return {"t": "state", "w": self.cfg["width"], "h": self.cfg["height"], "fps": self.cfg["fps"],
                "gpu": self.cfg.get("gpu"), "stopped": self.stopped, "restarting": self.restarting,
                "encoder": "nvenc" if self.encoders["h264"].nvenc else "x264",
                "audio": bool(self.cfg.get("audio_source"))}

    async def broadcast(self, msg):
        data = json.dumps(msg)
        for ws in list(self.ctl_clients):
            try:
                await ws.send_str(data)
            except ConnectionError:
                pass

    # ------------------------------------------------------------- handlers
    async def health(self, request):
        return web.json_response(
            {"ok": True, "stopped": self.stopped, "clients": len(self.ctl_clients),
             "idle": int(time.time() - self.last_client) if not self.ctl_clients else 0},
            headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"})

    async def media_ws(self, request):
        if not self.authorised(request):
            return web.Response(status=403, text="bad key")
        kind = request.match_info["kind"]
        if kind == "video":
            kind = "mpeg1" if request.query.get("codec") == "mpeg1" else "h264"
        enc = self.encoders.get(kind)
        if not enc or (kind == "audio" and not self.cfg.get("audio_source")):
            return web.Response(status=404)
        ws = web.WebSocketResponse(max_msg_size=1 << 16, heartbeat=20, compress=False)
        await ws.prepare(request)
        q = asyncio.Queue()
        enc.add(q)
        log(f"{kind} viewer connected")
        framed = kind == "h264"
        limit = max(8, self.cfg["fps"] // 3)  # ~1/3 s of frames queued: the link is behind

        async def pump():
            waiting_for_key = True
            while True:
                data, key = await q.get()
                if framed:
                    if q.qsize() > limit:
                        # Too far behind: drop what is queued and start again from a fresh keyframe.
                        while not q.empty():
                            q.get_nowait()
                        waiting_for_key = True
                        enc.keyframe()
                        continue
                    if waiting_for_key and not key:
                        continue
                    waiting_for_key = False
                    await ws.send_bytes(bytes((1 if key else 0,)) + data)
                else:
                    while not q.empty() and len(data) < 262144:
                        data += q.get_nowait()[0]
                    await ws.send_bytes(data)

        sender = asyncio.create_task(pump())
        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT and msg.data == "kf" and framed:
                    enc.keyframe()
        finally:
            sender.cancel()
            enc.remove(q)
            log(f"{kind} viewer left")
        return ws

    async def ctl_ws(self, request):
        if not self.authorised(request):
            return web.Response(status=403, text="bad key")
        ws = web.WebSocketResponse(max_msg_size=1 << 16, heartbeat=20)
        await ws.prepare(request)
        self.ctl_clients.add(ws)
        self.last_client = time.time()
        log("controller connected")
        await ws.send_str(json.dumps(self.state()))
        if self.last_cursor:
            await ws.send_str(json.dumps(self.last_cursor))
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                self.last_client = time.time()
                try:
                    reply = await self.handle(json.loads(msg.data))
                except Exception as e:  # one bad message must not drop the session
                    log("input error:", repr(e), msg.data[:200])
                    continue
                if reply:
                    await ws.send_str(json.dumps(reply))
        finally:
            self.ctl_clients.discard(ws)
            self.last_client = time.time()
            if not self.ctl_clients:
                self.screen.release_all()  # a page that vanished must not leave a key down
            log("controller left")
        return ws

    async def handle(self, m):
        t = m.get("t")
        s = self.screen
        W, H = self.cfg["width"], self.cfg["height"]

        def px(m):
            return (min(max(float(m.get("x", 0)), 0.0), 1.0) * (W - 1),
                    min(max(float(m.get("y", 0)), 0.0), 1.0) * (H - 1))

        if t == "ping":
            return {"t": "pong", "ts": m.get("ts")}
        if self.stopped:
            return None
        if t == "mm":
            s.move(*px(m))
        elif t == "mr":
            s.move_rel(float(m.get("dx", 0)), float(m.get("dy", 0)))
        elif t == "mb":
            b = {0: 1, 1: 2, 2: 3}.get(int(m.get("b", 0)), 1)
            if "x" in m:
                s.move(*px(m))
            s.button(b, bool(m.get("d")))
        elif t == "wh":
            s.wheel(float(m.get("dx", 0)), float(m.get("dy", 0)))
        elif t == "k":
            code, down = str(m.get("code", "")), bool(m.get("d"))
            s.key(code, down)
            if down and code in ("KeyC", "KeyX") and s.ctrl_held():
                asyncio.create_task(self.send_clipboard())
        elif t == "rel":
            s.release_all()
        elif t == "text":
            text = str(m.get("s", ""))[:2000]
            if text:
                await asyncio.get_running_loop().run_in_executor(None, s.type_text, text)
        elif t == "paste":  # the device's clipboard, pasted into Studio
            text = str(m.get("s", ""))[:100000]
            if text:
                await asyncio.get_running_loop().run_in_executor(None, s.set_clipboard, text)
                await asyncio.sleep(0.1)
                if s.ctrl_held():
                    s.tap("KeyV")
                else:
                    s.tap("KeyV", ["ControlLeft"])
        elif t == "key":  # one key from the phone's keyboard, with modifiers
            mods = [x for x in m.get("mods", []) if x in ("ControlLeft", "ShiftLeft", "AltLeft")]
            s.tap(str(m.get("k", "")), mods)
        elif t == "stop":
            await self.stop("stopped from the page")
        elif t == "restart":
            asyncio.create_task(self.restart_studio())
        return None

    async def send_clipboard(self):
        """After Ctrl+C in Studio, offer what it copied to the page."""
        await asyncio.sleep(0.4)
        text = await asyncio.get_running_loop().run_in_executor(None, self.screen.get_clipboard)
        if text:
            await self.broadcast({"t": "clip", "s": text[:100000]})

    # ------------------------------------------------------------ lifecycle
    async def restart_studio(self):
        if self.restarting or self.stopped:
            return
        self.restarting = True
        await self.broadcast(self.state())
        try:
            proc = await asyncio.create_subprocess_exec(
                "bash", self.cfg["launcher"], "--restart",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            out, _ = await proc.communicate()
            log("restart:", out.decode(errors="replace")[-800:])
        finally:
            self.restarting = False
            await self.broadcast(self.state())

    async def stop(self, why):
        if self.stopped:
            return
        log("stopping:", why)
        self.stopped = True
        for enc in self.encoders.values():
            enc.viewers.clear()
            enc.kill()
        subprocess.run("WINEPREFIX=/content/wineprefix wineserver -k", shell=True)
        self.write_state()
        await self.broadcast({"t": "stopped", "why": why})

    def write_state(self):
        tmp = self.cfg["state_file"] + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"ts": time.time(), "clients": len(self.ctl_clients), "last_client": self.last_client,
                       "stopped": self.stopped}, f)
        os.replace(tmp, self.cfg["state_file"])

    async def housekeeping(self):
        last_state = 0.0
        last_scan = 0.0
        while True:
            now = time.monotonic()
            if now - last_scan > 1.0 and not self.screen.held_buttons:
                last_scan = now
                try:
                    self.screen.maximise_studio()
                except xerror.XError as e:
                    log("X error:", e)
            if self.ctl_clients:
                try:
                    c = self.screen.cursor()
                except xerror.XError as e:
                    log("X error:", e)
                    c = None
                if c:
                    self.last_cursor = c
                    await self.broadcast(c)
            if now - last_state > 5:
                last_state = now
                self.write_state()
            await asyncio.sleep(0.05)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("config")
    cfg = json.load(open(ap.parse_args().config))
    st = Streamer(cfg)

    app = web.Application()
    app.router.add_get("/health", st.health)
    app.router.add_get("/ctl", st.ctl_ws)
    app.router.add_get("/{kind:video|audio}", st.media_ws)
    app.router.add_get("/", lambda r: web.Response(text="ok\n"))

    async def start(app):
        loop = asyncio.get_running_loop()
        app["tasks"] = [loop.create_task(st.housekeeping())]

    app.on_startup.append(start)
    log(f"listening on 127.0.0.1:{cfg['port']} {cfg['width']}x{cfg['height']}@{cfg['fps']}")
    try:
        web.run_app(app, host="127.0.0.1", port=cfg["port"], print=None, access_log=None)
    finally:
        for enc in st.encoders.values():
            enc.kill()


if __name__ == "__main__":
    main()
