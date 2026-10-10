/* Turns what happens on the page into keyboard and mouse input for Studio.
 * Messages go to vm/streamer.py over the /ctl websocket:
 *   mm {x,y}        move the mouse (x, y from 0 to 1 across the picture)
 *   mr {dx,dy}      move the mouse by stream pixels (camera turning)
 *   mb {b,d,x?,y?}  button b (0 left, 1 middle, 2 right) down (d=1) or up
 *   wh {dx,dy}      wheel
 *   k  {code,d}     a key, by KeyboardEvent.code
 *   text {s}, key {k,mods}, paste {s}
 *
 * PC: the mouse and keyboard are passed through. Holding the right (or middle)
 * button captures the pointer, so turning the camera never runs into the edge
 * of the screen.
 *
 * Mobile:
 *  - a dynamic thumbstick, like Roblox's: touch anywhere in the lower left and
 *    it appears under your thumb. It holds W/A/S/D, which fly Studio's camera.
 *    A quick tap there is still a click.
 *  - E and Q buttons fly up and down.
 *  - Dragging anywhere else turns the camera (a right-drag in Studio), or, in
 *    Cursor mode, drags with the left button (moving parts, sliders, panels).
 *  - Tap: click. Long press, or the right-click button then a tap: right-click.
 *  - Two fingers: pinch to zoom, slide to scroll. */
"use strict";
(() => {
  const STICK_RADIUS = 56; // CSS px the knob can travel
  const DEADZONE = 0.28;
  const TAP_MOVE = 10; // CSS px a tap may wander
  const LONG_PRESS = 550; // ms
  const TURN_SPEED = 1.0; // stream px per CSS px of finger travel

  class Controls {
    constructor({ screen, touchUi, stickZone, stick, knob, send, getCanvas, onActivity }) {
      this.screen = screen;
      this.touchUi = touchUi;
      this.stickZone = stickZone;
      this.stick = stick;
      this.knob = knob;
      this.send = send;
      this.getCanvas = getCanvas;
      this.onActivity = onActivity || (() => {});
      this.mode = "pc";
      this.touchMode = "camera";
      this.stickOn = true;
      this.nextRight = false;
      this.dims = { w: 1600, h: 900 };
      this.pending = { mm: null, dx: 0, dy: 0 };
      this.flushQueued = false;
      this.relButtons = new Set(); // mouse buttons held in relative (camera) mode
      this.touches = new Map();
      this.stickState = null;
      this.stickKeys = new Set();
      this.bindPc();
      this.bindTouch();
    }

    setMode(mode) {
      this.letGo();
      this.mode = mode;
      this.touchUi.hidden = mode !== "mobile";
    }

    setTouchMode(m) {
      this.letGo();
      this.touchMode = m;
    }

    setStick(on) {
      this.stickOn = on;
      this.stickZone.hidden = !on;
    }

    // ------------------------------------------------------------ helpers
    norm(clientX, clientY) {
      const c = this.getCanvas();
      const r = (c || this.screen).getBoundingClientRect();
      return {
        x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)),
        y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)),
      };
    }

    scale() {
      // stream pixels per CSS pixel
      const c = this.getCanvas();
      const r = (c || this.screen).getBoundingClientRect();
      return r.width ? this.dims.w / r.width : 1;
    }

    queue() {
      if (this.flushQueued) return;
      this.flushQueued = true;
      requestAnimationFrame(() => this.flush());
    }

    flush() {
      this.flushQueued = false;
      const p = this.pending;
      if (p.mm) {
        this.send({ t: "mm", x: r4(p.mm.x), y: r4(p.mm.y) });
        p.mm = null;
      }
      if (p.dx || p.dy) {
        const dx = Math.trunc(p.dx);
        const dy = Math.trunc(p.dy);
        if (dx || dy) this.send({ t: "mr", dx, dy });
        p.dx -= dx;
        p.dy -= dy;
      }
    }

    click(pos, b = 0) {
      this.flush();
      this.send({ t: "mb", b, d: 1, x: r4(pos.x), y: r4(pos.y) });
      this.send({ t: "mb", b, d: 0, x: r4(pos.x), y: r4(pos.y) });
    }

    key(code, down) {
      this.send({ t: "k", code, d: down ? 1 : 0 });
    }

    /** Let go of everything (the page lost focus, the mode changed, ...). */
    letGo() {
      this.flush();
      for (const b of this.relButtons) this.send({ t: "mb", b, d: 0 });
      this.relButtons.clear();
      for (const t of this.touches.values()) this.endTouchGesture(t, true);
      this.touches.clear();
      this.endStick(null, true);
      if (document.pointerLockElement) document.exitPointerLock();
      this.send({ t: "rel" });
    }

    // ----------------------------------------------------------------- PC
    bindPc() {
      const el = this.screen;
      el.addEventListener("mousedown", (e) => {
        if (this.mode !== "pc" || e.sourceCapabilities?.firesTouchEvents) return;
        e.preventDefault();
        el.focus({ preventScroll: true });
        this.onActivity();
        const pos = this.norm(e.clientX, e.clientY);
        this.pending.mm = null;
        if (e.button === 1 || e.button === 2) {
          // Turning or panning the camera: relative movement from here on.
          this.relButtons.add(e.button);
          this.send({ t: "mb", b: e.button, d: 1, x: r4(pos.x), y: r4(pos.y) });
          this.lock();
        } else if (this.relButtons.size) {
          this.send({ t: "mb", b: e.button, d: 1 });
        } else {
          this.send({ t: "mb", b: e.button, d: 1, x: r4(pos.x), y: r4(pos.y) });
        }
      });
      addEventListener("mouseup", (e) => {
        if (this.mode !== "pc") return;
        if (this.relButtons.has(e.button)) {
          this.flush();
          this.relButtons.delete(e.button);
          this.send({ t: "mb", b: e.button, d: 0 });
          if (!this.relButtons.size && document.pointerLockElement) document.exitPointerLock();
          return;
        }
        if (!this.screen.contains(e.target) && e.target !== document.documentElement && !document.pointerLockElement) {
          // released outside the picture: still release the button in Studio
          this.send({ t: "mb", b: e.button, d: 0 });
          return;
        }
        this.flush();
        const pos = this.norm(e.clientX, e.clientY);
        this.send({ t: "mb", b: e.button, d: 0, x: r4(pos.x), y: r4(pos.y) });
      });
      addEventListener("mousemove", (e) => {
        if (this.mode !== "pc" || this.stageHidden()) return;
        if (this.relButtons.size) {
          const s = this.scale();
          this.pending.dx += e.movementX * s;
          this.pending.dy += e.movementY * s;
          this.queue();
          return;
        }
        if (!this.screen.contains(e.target)) return;
        this.pending.mm = this.norm(e.clientX, e.clientY);
        this.queue();
      });
      el.addEventListener("contextmenu", (e) => e.preventDefault());
      el.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          if (this.mode !== "pc") return;
          const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
          this.send({ t: "wh", dx: e.deltaX * k, dy: e.deltaY * k });
        },
        { passive: false }
      );

      // Keys. The page's own text boxes keep theirs.
      const ours = (e) => e.target && e.target.closest && e.target.closest("input, textarea, select, dialog");
      addEventListener("keydown", (e) => {
        if (this.stageHidden() || ours(e)) return;
        if (e.code === "F11") return;
        // Ctrl/Cmd+V: let the browser fire "paste" with the device's clipboard.
        if ((e.ctrlKey || e.metaKey) && e.code === "KeyV") return;
        e.preventDefault();
        if (this.mode === "pc" || e.code) this.key(e.code, true);
      });
      addEventListener("keyup", (e) => {
        if (this.stageHidden() || ours(e)) return;
        if ((e.ctrlKey || e.metaKey) && e.code === "KeyV") return;
        e.preventDefault();
        this.key(e.code, false);
      });
      addEventListener("paste", (e) => {
        if (this.stageHidden() || ours(e)) return;
        const text = e.clipboardData && e.clipboardData.getData("text/plain");
        if (text) {
          e.preventDefault();
          this.send({ t: "paste", s: text.slice(0, 100000) });
        }
      });
    }

    lock() {
      const el = this.screen;
      try {
        const p = el.requestPointerLock({ unadjustedMovement: true });
        if (p && p.catch) p.catch(() => el.requestPointerLock());
      } catch {
        try {
          el.requestPointerLock();
        } catch {}
      }
    }

    stageHidden() {
      return !!this.screen.closest("[hidden]") || !!document.querySelector("dialog[open]");
    }

    // -------------------------------------------------------------- touch
    bindTouch() {
      // The thumbstick zone.
      const zone = this.stickZone;
      zone.addEventListener("pointerdown", (e) => {
        if (this.mode !== "mobile") return;
        e.preventDefault();
        e.stopPropagation();
        if (this.stickState) return;
        try {
          zone.setPointerCapture(e.pointerId);
        } catch {}
        this.onActivity();
        const r = zone.getBoundingClientRect();
        this.stickState = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false, cx: e.clientX, cy: e.clientY };
        this.stick.classList.remove("resting");
        this.stick.style.left = `${e.clientX - r.left}px`;
        this.stick.style.top = `${e.clientY - r.top}px`;
        this.knob.style.transform = "translate(-50%, -50%)";
      });
      zone.addEventListener("pointermove", (e) => {
        const s = this.stickState;
        if (!s || s.id !== e.pointerId) return;
        e.preventDefault();
        s.cx = e.clientX;
        s.cy = e.clientY;
        let dx = e.clientX - s.x0;
        let dy = e.clientY - s.y0;
        const len = Math.hypot(dx, dy);
        if (len > STICK_RADIUS) {
          dx = (dx / len) * STICK_RADIUS;
          dy = (dy / len) * STICK_RADIUS;
        }
        this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        const nx = dx / STICK_RADIUS;
        const ny = dy / STICK_RADIUS;
        const want = new Set();
        if (Math.hypot(nx, ny) > DEADZONE) {
          s.moved = true;
          if (ny < -0.38) want.add("KeyW");
          if (ny > 0.38) want.add("KeyS");
          if (nx < -0.38) want.add("KeyA");
          if (nx > 0.38) want.add("KeyD");
        }
        for (const k of this.stickKeys) if (!want.has(k)) this.key(k, false);
        for (const k of want) if (!this.stickKeys.has(k)) this.key(k, true);
        this.stickKeys = want;
      });
      const stickEnd = (e) => {
        const s = this.stickState;
        if (!s || s.id !== e.pointerId) return;
        this.endStick(e, false);
      };
      zone.addEventListener("pointerup", stickEnd);
      zone.addEventListener("pointercancel", (e) => {
        const s = this.stickState;
        if (s && s.id === e.pointerId) this.endStick(e, true);
      });

      // Fly up / down.
      const hold = (btn, code) => {
        const up = (e) => {
          if (btn.dataset.held) {
            delete btn.dataset.held;
            btn.classList.remove("held");
            this.key(code, false);
          }
          e.preventDefault();
        };
        btn.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            btn.setPointerCapture(e.pointerId);
          } catch {}
          btn.dataset.held = "1";
          btn.classList.add("held");
          this.key(code, true);
        });
        btn.addEventListener("pointerup", up);
        btn.addEventListener("pointercancel", up);
        btn.addEventListener("contextmenu", (e) => e.preventDefault());
      };
      hold(document.getElementById("upBtn"), "KeyE");
      hold(document.getElementById("downBtn"), "KeyQ");

      // Fingers on the picture.
      const el = this.screen;
      el.addEventListener("pointerdown", (e) => {
        if (this.mode !== "mobile") return;
        e.preventDefault();
        el.focus({ preventScroll: true });
        this.onActivity();
        try {
          el.setPointerCapture(e.pointerId);
        } catch {}
        const t = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: performance.now(), state: "pending" };
        this.touches.set(e.pointerId, t);
        if (this.touches.size === 2) {
          // A second finger: whatever the first was doing becomes a pinch/scroll.
          for (const o of this.touches.values()) if (o !== t) this.endTouchGesture(o, true);
          for (const o of this.touches.values()) o.state = "two";
          this.two = this.twoFinger();
          return;
        }
        if (this.touches.size > 2) {
          t.state = "ignored";
          return;
        }
        t.timer = setTimeout(() => {
          if (t.state === "pending") {
            t.state = "done";
            this.click(this.norm(t.x, t.y), 2); // long press: right-click
            if (navigator.vibrate) navigator.vibrate(15);
          }
        }, LONG_PRESS);
      });
      el.addEventListener("pointermove", (e) => {
        const t = this.touches.get(e.pointerId);
        if (!t || this.mode !== "mobile") return;
        e.preventDefault();
        const ddx = e.clientX - t.x;
        const ddy = e.clientY - t.y;
        t.x = e.clientX;
        t.y = e.clientY;
        if (t.state === "two") {
          this.twoFingerMove();
          return;
        }
        if (t.state === "pending" && Math.hypot(t.x - t.x0, t.y - t.y0) > TAP_MOVE) {
          clearTimeout(t.timer);
          const start = this.norm(t.x0, t.y0);
          if (this.touchMode === "camera") {
            t.state = "turn";
            this.send({ t: "mb", b: 2, d: 1, x: r4(start.x), y: r4(start.y) });
            this.pending.dx += (t.x - t.x0) * TURN_SPEED * this.scale();
            this.pending.dy += (t.y - t.y0) * TURN_SPEED * this.scale();
            this.queue();
          } else {
            t.state = "drag";
            this.send({ t: "mb", b: 0, d: 1, x: r4(start.x), y: r4(start.y) });
            this.pending.mm = this.norm(t.x, t.y);
            this.queue();
          }
          return;
        }
        if (t.state === "turn") {
          this.pending.dx += ddx * TURN_SPEED * this.scale();
          this.pending.dy += ddy * TURN_SPEED * this.scale();
          this.queue();
        } else if (t.state === "drag") {
          this.pending.mm = this.norm(t.x, t.y);
          this.queue();
        }
      });
      const end = (e, cancelled) => {
        const t = this.touches.get(e.pointerId);
        if (!t) return;
        this.touches.delete(e.pointerId);
        if (t.state === "two") {
          for (const o of this.touches.values()) o.state = "ignored"; // lift both before a new gesture
          this.two = null;
          return;
        }
        this.endTouchGesture(t, cancelled);
      };
      el.addEventListener("pointerup", (e) => end(e, false));
      el.addEventListener("pointercancel", (e) => end(e, true));
    }

    endStick(e, cancelled) {
      const s = this.stickState;
      if (!s) return;
      this.stickState = null;
      for (const k of this.stickKeys) this.key(k, false);
      this.stickKeys = new Set();
      this.stick.classList.add("resting");
      this.stick.style.left = this.stick.style.top = "";
      this.knob.style.transform = "translate(-50%, -50%)";
      // A quick touch that never moved the stick is a tap on whatever is under it.
      if (!cancelled && e && !s.moved && performance.now() - s.t0 < 300) this.tapAt(s.x0, s.y0);
    }

    tapAt(x, y) {
      const right = this.nextRight;
      if (right) this.setNextRight(false);
      this.click(this.norm(x, y), right ? 2 : 0);
    }

    setNextRight(on) {
      this.nextRight = on;
      document.getElementById("rclickBtn").classList.toggle("on", on);
    }

    endTouchGesture(t, cancelled) {
      clearTimeout(t.timer);
      if (t.state === "pending" && !cancelled) {
        t.state = "done";
        this.tapAt(t.x0, t.y0);
      } else if (t.state === "turn") {
        this.flush();
        this.send({ t: "mb", b: 2, d: 0 });
      } else if (t.state === "drag") {
        this.flush();
        const p = this.norm(t.x, t.y);
        this.send({ t: "mb", b: 0, d: 0, x: r4(p.x), y: r4(p.y) });
      }
      t.state = "done";
    }

    twoFinger() {
      const [a, b] = [...this.touches.values()];
      return { dist: Math.hypot(a.x - b.x, a.y - b.y), my: (a.y + b.y) / 2, mx: (a.x + b.x) / 2 };
    }

    twoFingerMove() {
      if (!this.two || this.touches.size !== 2) return;
      const now = this.twoFinger();
      const dDist = now.dist - this.two.dist;
      const dMy = now.my - this.two.my;
      if (Math.abs(dDist) > 24) {
        // Pinch: zoom the camera (wheel). Fingers apart = zoom in.
        const pos = this.norm(now.mx, now.my);
        this.pending.mm = pos;
        this.flush();
        this.send({ t: "wh", dx: 0, dy: dDist > 0 ? -120 : 120 });
        this.two = now;
      } else if (Math.abs(dMy) > 18) {
        // Two-finger slide: scroll whatever is under the fingers.
        this.pending.mm = this.norm(now.mx, now.my);
        this.flush();
        this.send({ t: "wh", dx: 0, dy: dMy > 0 ? -100 : 100 });
        this.two = now;
      }
    }
  }

  const r4 = (v) => Math.round(v * 10000) / 10000;
  window.Controls = Controls;
})();
