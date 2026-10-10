/* The picture and sound from the cloud machine (vm/streamer.py).
 *
 * Video, best first:
 *  - "h264": every websocket message is one H.264 frame (a flag byte, then the
 *    frame) encoded on the GPU. The browser's own, usually hardware, decoder
 *    (WebCodecs VideoDecoder) decodes it and it is drawn straight onto a
 *    canvas: 60 fps, little delay, light on the CPU.
 *  - "mpeg1": MPEG-1 decoded in JavaScript by JSMpeg, for browsers without
 *    WebCodecs H.264. 30 fps.
 * Sound is MP2 through JSMpeg, only while it is switched on. */
"use strict";
(() => {
  // ------------------------------------------------------------ H.264 bits
  /** Split an Annex-B access unit into NAL units (without start codes). */
  function nalUnits(au) {
    const out = [];
    let i = 0;
    let start = -1;
    const n = au.length;
    while (i + 2 < n) {
      if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
        if (start >= 0) {
          let end = i;
          if (end > start && au[end - 1] === 0) end--; // the 4-byte start code's extra zero
          out.push(au.subarray(start, end));
        }
        i += 3;
        start = i;
      } else i++;
    }
    if (start >= 0 && start < n) out.push(au.subarray(start));
    return out;
  }

  /** Annex-B -> length-prefixed ("avc"): what every WebCodecs implementation takes. */
  function toAvcc(nals) {
    let size = 0;
    for (const u of nals) size += 4 + u.length;
    const out = new Uint8Array(size);
    let o = 0;
    for (const u of nals) {
      const l = u.length;
      out[o] = l >>> 24;
      out[o + 1] = (l >>> 16) & 255;
      out[o + 2] = (l >>> 8) & 255;
      out[o + 3] = l & 255;
      out.set(u, o + 4);
      o += 4 + l;
    }
    return out;
  }

  function avcDescription(sps, pps) {
    const d = new Uint8Array(11 + sps.length + pps.length);
    d.set([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 255], 0);
    d.set(sps, 8);
    d.set([1, pps.length >> 8, pps.length & 255], 8 + sps.length);
    d.set(pps, 11 + sps.length);
    return d;
  }

  const hex2 = (v) => v.toString(16).padStart(2, "0");
  const codecOf = (sps) => `avc1.${hex2(sps[1])}${hex2(sps[2])}${hex2(sps[3])}`;
  const sameBytes = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);

  /** Whether this browser can decode the stream's H.264 with WebCodecs. */
  async function canDecodeH264() {
    if (typeof VideoDecoder !== "function" || typeof EncodedVideoChunk !== "function") return false;
    try {
      const r = await VideoDecoder.isConfigSupported({ codec: "avc1.64002a", codedWidth: 1920, codedHeight: 1080, optimizeForLatency: true });
      return !!r.supported;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- player
  class StreamPlayer {
    /**
     * @param {HTMLElement} host  where the <canvas> goes
     * @param {object} hooks      onFirstFrame(), onFallback(why)
     */
    constructor(host, hooks = {}) {
      this.host = host;
      this.hooks = hooks;
      this.canvas = null;
      this.ws = null;
      this.decoder = null;
      this.jsmpeg = null;
      this.sound = null;
      this.codec = null;
      this.closed = false;
      this.frames = 0;
      this.fps = 0;
      this.bytes = 0;
      this.kbps = 0;
      this.lastStat = performance.now();
      this.lastFrameAt = 0;
      this.statTimer = setInterval(() => this.stat(), 1000);
    }

    newCanvas(w, h) {
      if (this.canvas) this.canvas.remove();
      const c = document.createElement("canvas");
      c.className = "video";
      c.width = w || 1600;
      c.height = h || 900;
      this.host.appendChild(c);
      this.canvas = c;
      return c;
    }

    async start(base, key, { w, h, prefer } = {}) {
      this.base = base.replace(/^http/, "ws");
      this.key = key;
      this.w = w;
      this.h = h;
      const h264 = prefer !== "mpeg1" && (await canDecodeH264());
      if (this.closed) return;
      if (h264) this.startH264();
      else this.startMpeg1(prefer === "mpeg1" ? "chosen" : "no WebCodecs H.264 here");
    }

    // ---- WebCodecs
    startH264() {
      this.codec = "h264";
      const canvas = this.newCanvas(this.w, this.h);
      this.ctx = canvas.getContext("2d", { alpha: false, desynchronized: true }) || canvas.getContext("2d");
      this.waitKey = true;
      this.ts = 0;
      this.errors = 0;
      this.sps = null;
      this.lastKfAsk = 0;
      this.openVideoSocket(`${this.base}/video?k=${encodeURIComponent(this.key)}`, (data) => this.onH264(data));
    }

    openVideoSocket(url, onData) {
      if (this.closed) return;
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onmessage = (e) => {
        const data = new Uint8Array(e.data);
        this.bytes += data.length;
        onData(data);
      };
      ws.onclose = () => {
        if (this.ws !== ws || this.closed) return;
        this.waitKey = true;
        setTimeout(() => this.ws === ws && this.openVideoSocket(url, onData), 1500);
      };
    }

    askKeyframe() {
      const now = performance.now();
      if (now - this.lastKfAsk < 1500) return;
      this.lastKfAsk = now;
      try {
        this.ws.send("kf");
      } catch {}
    }

    onH264(data) {
      const isKey = (data[0] & 1) === 1;
      if (this.waitKey && !isKey) {
        if (this.decoder) this.askKeyframe(); // rate-limited; keeps asking until one comes
        return;
      }
      const nals = nalUnits(data.subarray(1)).filter((u) => (u[0] & 0x1f) !== 9); // drop delimiters
      if (isKey) {
        const sps = nals.find((u) => (u[0] & 0x1f) === 7);
        const pps = nals.find((u) => (u[0] & 0x1f) === 8);
        if (sps && pps && (!this.decoder || this.decoder.state === "closed" || !sameBytes(sps, this.sps))) {
          this.configure(sps, pps);
        }
      }
      const dec = this.decoder;
      if (!dec || dec.state !== "configured") return;
      if (!isKey && dec.decodeQueueSize > 30) {
        // Half a second of frames waiting: the decoder cannot keep up. Skip to a
        // fresh keyframe instead of piling up delay (bursts from the network are fine).
        this.waitKey = true;
        this.askKeyframe();
        return;
      }
      this.waitKey = false;
      this.ts += 16667;
      try {
        dec.decode(new EncodedVideoChunk({ type: isKey ? "key" : "delta", timestamp: this.ts, data: toAvcc(nals) }));
      } catch (e) {
        this.decodeFailed(e);
      }
    }

    configure(sps, pps) {
      if (this.decoder && this.decoder.state !== "closed") {
        try {
          this.decoder.close();
        } catch {}
      }
      this.sps = sps;
      const dec = new VideoDecoder({
        output: (frame) => this.draw(frame),
        error: (e) => this.decodeFailed(e),
      });
      dec.configure({ codec: codecOf(sps), description: avcDescription(sps, pps), optimizeForLatency: true });
      this.decoder = dec;
    }

    decodeFailed(e) {
      if (this.closed || this.codec !== "h264") return;
      this.errors++;
      console.warn("H.264 decoder:", e && e.message);
      this.decoder = null;
      this.waitKey = true;
      if (this.errors >= 4 && !this.frames) {
        this.stopVideo();
        this.startMpeg1("this browser's H.264 decoder failed");
        return;
      }
      this.askKeyframe();
    }

    draw(frame) {
      const c = this.canvas;
      if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) {
        c.width = frame.displayWidth;
        c.height = frame.displayHeight;
      }
      this.ctx.drawImage(frame, 0, 0);
      frame.close();
      this.gotFrame();
    }

    gotFrame() {
      this.frames++;
      this.lastFrameAt = performance.now();
      if (this.frames === 1 && this.hooks.onFirstFrame) this.hooks.onFirstFrame();
    }

    // ---- JSMpeg
    startMpeg1(why) {
      this.codec = "mpeg1";
      if (this.hooks.onFallback) this.hooks.onFallback(why);
      const canvas = this.newCanvas(this.w, this.h);
      this.jsmpeg = new JSMpeg.Player(`${this.base}/video?codec=mpeg1&k=${encodeURIComponent(this.key)}`, {
        canvas,
        audio: false,
        video: true,
        pauseWhenHidden: false,
        videoBufferSize: 2 * 1024 * 1024,
        reconnectInterval: 2,
        onVideoDecode: () => this.gotFrame(),
      });
    }

    // ---- sound
    setSound(on) {
      if (on && !this.sound) {
        this.sound = new JSMpeg.Player(`${this.base}/audio?k=${encodeURIComponent(this.key)}`, {
          video: false,
          audio: true,
          pauseWhenHidden: false,
          audioBufferSize: 128 * 1024,
          maxAudioLag: 0.2,
          reconnectInterval: 2,
        });
        this.unlockSound();
      } else if (!on && this.sound) {
        try {
          this.sound.destroy();
        } catch {}
        this.sound = null;
      }
    }

    unlockSound() {
      const out = this.sound && this.sound.audioOut;
      try {
        if (out && out.unlock) out.unlock(() => {});
        if (out && out.context && out.context.state === "suspended") out.context.resume();
      } catch {}
    }

    // ---- stats and teardown
    stat() {
      const now = performance.now();
      const dt = (now - this.lastStat) / 1000;
      this.fps = Math.round((this.frames - (this.statFrames || 0)) / dt);
      this.kbps = Math.round((this.bytes * 8) / 1000 / dt);
      this.statFrames = this.frames;
      this.bytes = 0;
      this.lastStat = now;
    }

    stopVideo() {
      if (this.ws) {
        const ws = this.ws;
        this.ws = null;
        ws.onclose = null;
        try {
          ws.close();
        } catch {}
      }
      if (this.decoder && this.decoder.state !== "closed") {
        try {
          this.decoder.close();
        } catch {}
      }
      this.decoder = null;
      if (this.jsmpeg) {
        try {
          this.jsmpeg.destroy();
        } catch {}
        this.jsmpeg = null;
      }
    }

    destroy() {
      this.closed = true;
      clearInterval(this.statTimer);
      this.stopVideo();
      this.setSound(false);
      if (this.canvas) this.canvas.remove();
      this.canvas = null;
    }
  }

  window.StreamPlayer = StreamPlayer;
})();
