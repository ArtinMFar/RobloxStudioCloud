/* Roblox Studio Cloud: the page.
 *
 * Static, so it has two helpers:
 *  - the backend workflow (.github/workflows/session.yml), started through the
 *    GitHub API. It finishes the Google sign-in, and for a session it rents the
 *    cloud GPU machine, builds and runs the setup notebook on it and keeps the
 *    machine while Studio is open. When it starts it opens a short-lived HTTPS
 *    address of its own and announces it with its one-time public key; the
 *    page then talks to it directly (sign-in code, progress, stop). Everything
 *    secret the page sends it is sealed for that key, and what comes back is
 *    sealed for the page's own one-time key.
 *  - the cloud machine itself (vm/streamer.py), once Studio is up: the picture
 *    over /video, input over /ctl.
 * The Google sign-in is kept in this browser only. */
"use strict";
(() => {
  const CFG = window.RSC_CONFIG || {};
  // The colab CLI's own Google sign-in: its OAuth client, scopes and the page
  // that shows the code. The backend finishes it with the CLI's client config.
  const GOOGLE = {
    clientId: "764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com",
    redirectUri: "https://sdk.cloud.google.com/applicationdefaultauthcode.html",
    scopes: [
      "openid",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/colaboratory",
      "https://www.googleapis.com/auth/drive.file",
    ],
  };
  const WORKFLOW = "session.yml";
  const STEPS = [
    ["queued", "Reserving a cloud machine", ["queued", "handoff"]],
    ["gpu", "Getting a GPU", ["gpu", "gpu-fallback"]],
    ["setup", "Installing Roblox Studio", ["vm", "install", "download"]],
    ["launch", "Starting Roblox Studio", ["launch"]],
    ["stream", "Connecting", ["stream", "ready"]],
  ];
  const RES = { 720: [1280, 720], 900: [1600, 900], 1080: [1920, 1080] };

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isTouchFirst = matchMedia("(pointer: coarse)").matches && !matchMedia("(pointer: fine)").matches;
  const hasTouch = navigator.maxTouchPoints > 0;

  // ------------------------------------------------------------- storage
  const store = {
    get(k, d = null) {
      try {
        const v = localStorage.getItem(k);
        return v === null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {}
    },
    del(k) {
      try {
        localStorage.removeItem(k);
      } catch {}
    },
  };

  function guessRepo() {
    if (CFG.repo) return CFG.repo;
    const host = location.hostname.toLowerCase();
    if (host.endsWith(".github.io")) {
      const first = location.pathname.split("/").filter(Boolean)[0];
      return `${host.slice(0, -".github.io".length)}/${first || host}`;
    }
    return "";
  }
  const REPO = guessRepo();

  const settings = Object.assign(
    {
      gpu: "L4",
      mode: isTouchFirst ? "mobile" : "pc",
      res: "900",
      fps: "60",
      dpi: isTouchFirst ? "120" : "96",
      limit: "120",
      touchMode: "camera",
      stick: true,
    },
    store.get("rsc.settings", {})
  );
  const saveSettings = () => store.set("rsc.settings", settings);

  // --------------------------------------------------------------- bytes
  const b64 = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  };
  const b64url = (bytes) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const random = (n) => crypto.getRandomValues(new Uint8Array(n));
  const randomId = () => Array.from(random(6), (b) => (b % 36).toString(36)).join("") + Date.now().toString(36).slice(-4);
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  async function sha256(text) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  }

  // ----------------------------------------------------------------- UI bits
  let toastTimer;
  function toast(text, kind = "", ms = 6000) {
    const t = $("#toast");
    t.textContent = text;
    t.className = "toast " + kind;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ms);
  }
  function setMsg(el, text, kind = "") {
    el.textContent = text || "";
    el.className = "msg" + (kind ? " " + kind : "");
  }
  function banner(el, text, kind = "") {
    el.hidden = !text;
    el.textContent = text || "";
    el.className = "banner" + (kind ? " " + kind : "");
  }
  function show(view) {
    $("#home").hidden = view !== "home";
    $("#launch").hidden = view !== "launch";
    $("#stage").hidden = view !== "stage";
    $("#topbar").hidden = view === "stage";
  }

  // ---------------------------------------------------------- backend (GitHub)
  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }
  const accessKey = () => CFG.token || store.get("rsc.access", "");

  async function api(path, { method = "GET", body } = {}) {
    const token = accessKey();
    if (!token || !REPO) throw new ApiError("This site needs an access key first: open Settings.", 0);
    let r;
    try {
      r = await fetch("https://api.github.com" + path, {
        method,
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError("Could not reach the service. Check your connection.", 0);
    }
    if (r.status === 204) return null;
    const text = await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    if (!r.ok) {
      console.warn("backend", method, path.split("?")[0], r.status, data && data.message);
      const m = (data && data.message) || "";
      const msg =
        r.status === 401
          ? "The site's access key is not valid any more."
          : /rate limit/i.test(m)
            ? "The service is busy. Wait a minute and try again."
            : r.status === 403 || r.status === 404
              ? "The site's access key does not allow this."
              : `The service said ${r.status}.`;
      throw new ApiError(msg, r.status);
    }
    return data;
  }
  const repoPath = () => `/repos/${REPO}`;

  /** Start the backend workflow; returns its run id. */
  async function dispatch(inputs) {
    const repo = await api(repoPath());
    const since = new Date(Date.now() - 60000).toISOString().replace(/\.\d+Z$/, "Z");
    const path = `${repoPath()}/actions/workflows/${WORKFLOW}/dispatches`;
    let res;
    try {
      res = await api(path, { method: "POST", body: { ref: repo.default_branch, inputs, return_run_details: true } });
    } catch (e) {
      if (e.status !== 422) throw e;
      res = await api(path, { method: "POST", body: { ref: repo.default_branch, inputs } });
    }
    if (res && res.workflow_run_id) return res.workflow_run_id;
    for (let i = 0; i < 40; i++) {
      // Older API: no run id in the answer, so find the run by its name (it has the session id).
      const list = await api(
        `${repoPath()}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=20&created=${encodeURIComponent(">=" + since)}`
      );
      const run = (list.workflow_runs || []).find((r) => (r.display_title || r.name || "").includes(inputs.session_id));
      if (run) return run.id;
      await sleep(1500);
    }
    throw new Error("The cloud service did not start. Try again.");
  }

  /** Wait for the backend's own address and one-time key ("handoff" status). */
  async function findHandoff(runId, sid, onTick) {
    const t0 = Date.now();
    let sha = null;
    while (Date.now() - t0 < 6 * 60000) {
      const run = await api(`${repoPath()}/actions/runs/${runId}`);
      sha = run.head_sha;
      const list = await api(`${repoPath()}/commits/${sha}/statuses?per_page=100`);
      const st = (list || []).find((s) => s.context === `rsc/${sid}`);
      let d = {};
      try {
        d = st ? JSON.parse(st.description || "{}") : {};
      } catch {}
      if (d.p === "handoff" && d.k && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(st.target_url || "")) {
        return { url: st.target_url, key: d.k };
      }
      if (d.p === "error") throw new Error(d.m || "The cloud service failed.");
      if (run.status === "completed") throw new Error((d && d.m) || "The cloud service stopped before it was ready. Try again.");
      if (onTick) onTick(run.status === "queued" ? "queued" : "starting", Math.round((Date.now() - t0) / 1000));
      await sleep(2000);
    }
    throw new Error("The cloud service is taking too long to start. Try again in a few minutes.");
  }

  async function backendCall(base, path, { method = "GET", body, key } = {}) {
    const url = `${base}${path}${path.includes("?") ? "&" : "?"}k=${encodeURIComponent(key || "")}`;
    const r = await fetch(url, { method, body, cache: "no-store", headers: body ? { "Content-Type": "text/plain" } : {} });
    const data = await r.json().catch(() => ({}));
    if (!r.ok && !data.error) data.error = `The cloud service answered ${r.status}.`;
    return data;
  }

  // ------------------------------------------------------------- home: steps
  function renderHome() {
    const google = store.get("rsc.google");
    const pending = store.get("rsc.pkce");
    const ready = !!accessKey() && !!REPO;
    banner($("#banner"), ready ? $("#banner").dataset.text || "" : "This site needs an access key before it can start Studio. Open Settings (top right) and paste the key the site's owner gave you.", ready ? $("#banner").dataset.kind || "" : "warn");

    $("#stepGoogle").classList.toggle("done", !!google);
    $("#googleSub").textContent = google
      ? `Signed in${google.email ? " as " + google.email : ""}.`
      : "Your Google account provides the cloud computer.";
    $("#googleBtnText").textContent = google ? "Use another Google account" : "Sign in with Google";

    const code = $("#stepCode");
    code.classList.toggle("done", !!google);
    code.classList.toggle("locked", !google && !pending);
    $("#codeForm").hidden = !!google;
    $("#codeSub").textContent = google ? "Done." : "The code from Google's page, starting with 4/";

    $("#accountChip").hidden = !google;
    $("#accountChip").textContent = google ? google.email || "Signed in" : "";

    $("#stepGpu").classList.toggle("locked", !google);
    $("#stepMode").classList.toggle("locked", !google);
    renderCards();
    $("#playBtn").disabled = !(google && ready);
    const [w, h] = streamSize();
    $("#playMeta").textContent = `${settings.gpu} · ${settings.mode === "mobile" ? "Mobile" : "PC"} controls · ${w}×${h} at ${settings.fps} fps`;
  }

  function renderCards() {
    $$(".card[data-gpu]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.gpu === settings.gpu)));
    $$("[data-mode]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === settings.mode)));
    const g = store.get("rsc.google");
    const l4 = $(".card[data-gpu='L4'] .card-desc");
    if (g && g.gpus && g.gpus.l4 === false) l4.textContent = "Not available on this Google account (it needs a paid Colab plan or compute units).";
  }

  function setHomeBanner(text, kind = "") {
    $("#banner").dataset.text = text || "";
    $("#banner").dataset.kind = kind;
    renderHome();
  }

  // ------------------------------------------------------- step 1: Google
  async function openGoogle() {
    const verifier = b64url(random(48));
    const challenge = b64url(await sha256(verifier));
    const state = b64url(random(16));
    store.set("rsc.pkce", { verifier, state, at: Date.now() });
    const url =
      "https://accounts.google.com/o/oauth2/auth?" +
      new URLSearchParams({
        response_type: "code",
        client_id: GOOGLE.clientId,
        redirect_uri: GOOGLE.redirectUri,
        scope: GOOGLE.scopes.join(" "),
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "consent select_account",
        token_usage: "remote",
        access_type: "offline",
      });
    const w = window.open(url, "_blank", "noopener");
    if (!w) location.href = url; // pop-ups blocked: go there in this tab (the steps are remembered)
    renderHome();
    setMsg($("#codeMsg"), "Google's page opened in a new tab. Copy the code it shows and paste it here.");
    $("#codeInput").focus();
  }
  $("#googleBtn").addEventListener("click", openGoogle);

  function cleanCode(raw) {
    raw = raw.trim();
    const m = raw.match(/[?&]code=([^&\s]+)/);
    return m ? decodeURIComponent(m[1]) : raw.replace(/\s+/g, "");
  }

  $("#codeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = cleanCode($("#codeInput").value);
    const msg = $("#codeMsg");
    const pk = store.get("rsc.pkce");
    if (!code) return;
    if (!pk || Date.now() - pk.at > 30 * 60000) {
      setMsg(msg, "That sign-in has expired. Press Sign in with Google again.", "error");
      return;
    }
    $("#codeBtn").disabled = true;
    try {
      const key = b64url(random(24));
      const pageKeys = nacl.box.keyPair();
      const sid = "l" + randomId();
      setMsg(msg, "Connecting…");
      const runId = await dispatch({
        action: "login",
        session_id: sid,
        key_hash: hex(await sha256(key)),
        page_key: b64(pageKeys.publicKey),
        options: "{}",
      });
      const h = await findHandoff(runId, sid, (state, secs) =>
        setMsg(msg, `${state === "queued" ? "Waiting for the sign-in service" : "Starting the sign-in service"}… ${secs}s (usually about 30s)`)
      );
      setMsg(msg, "Finishing the sign-in…");
      const res = await backendCall(h.url, "/hello", { method: "POST", key, body: seal(JSON.stringify({ key, code, verifier: pk.verifier }), h.key) });
      if (!res.ok) throw new Error(res.error || "Google did not accept the code. Sign in again.");
      const info = JSON.parse(openSealed(res.sealed, pageKeys));
      store.set("rsc.google", { token: info.token, email: info.email || "", gpus: info.gpus || null, at: Date.now() });
      store.del("rsc.pkce");
      $("#codeInput").value = "";
      setMsg(msg, "");
      applyGpuEligibility(true);
      renderHome();
      toast(`Signed in${info.email ? " as " + info.email : ""}.`);
    } catch (err) {
      setMsg(msg, err.message, "error");
    } finally {
      $("#codeBtn").disabled = false;
    }
  });

  function signOut() {
    store.del("rsc.google");
    store.del("rsc.pkce");
    renderHome();
    renderSettings();
    toast("Signed out on this device. You can also remove the access at myaccount.google.com/permissions.", "", 9000);
  }

  // ------------------------------------------------------ steps 3-4: GPU, mode
  function l4Known() {
    const g = store.get("rsc.google");
    if (g && g.gpus && g.gpus.l4 === false) return "account";
    const recent = store.get("rsc.l4Unavailable");
    if (recent && Date.now() - recent < 6 * 3600e3) return "recent";
    return null;
  }
  function applyGpuEligibility(announce) {
    const why = l4Known();
    if (settings.gpu === "L4" && why) {
      settings.gpu = "T4";
      saveSettings();
      const text =
        why === "account"
          ? "L4 isn't available on this Google account, so T4 was picked."
          : "L4 wasn't available last time, so T4 was picked.";
      setMsg($("#gpuMsg"), text);
      if (announce) toast(text, "warn", 8000);
    }
    renderCards();
  }
  $$(".card[data-gpu]").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.gpu === "L4" && l4Known() === "account") {
        setMsg($("#gpuMsg"), "L4 isn't available on this Google account.", "error");
        return;
      }
      settings.gpu = b.dataset.gpu;
      if (settings.gpu === "L4") store.del("rsc.l4Unavailable");
      saveSettings();
      setMsg($("#gpuMsg"), "");
      renderHome();
    })
  );

  function setMode(mode, quiet) {
    if (mode !== "pc" && mode !== "mobile") return;
    const changed = mode !== settings.mode;
    settings.mode = mode;
    saveSettings();
    renderHome();
    if (controls) controls.setMode(mode);
    $("#kbBtn").hidden = !(hasTouch || mode === "mobile");
    if (changed && !quiet && !$("#stage").hidden)
      toast(mode === "mobile" ? "Mobile controls: thumbstick, drag to turn, tap to click." : "PC controls: keyboard and mouse.");
  }
  $$("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

  function streamSize() {
    const [w0, h] = RES[settings.res] || RES[900];
    let w = w0;
    if (settings.mode === "mobile" && isTouchFirst) {
      const long = Math.max(screen.width, screen.height);
      const short = Math.min(screen.width, screen.height) || 1;
      w = Math.round((h * Math.min(2.4, Math.max(1.33, long / short))) / 8) * 8;
    }
    return [w, h];
  }

  // ---------------------------------------------------------------- session
  let session = store.get("rsc.session"); // {sid, key, runId, at, gpu, w, h, runner, stream, ...}
  let launchTick;
  let following = false;

  async function play() {
    if (session) return;
    const google = store.get("rsc.google");
    if (!google) return;
    $("#playBtn").disabled = true;
    setHomeBanner("");
    try {
      applyGpuEligibility(false);
      const key = b64url(random(32));
      const sid = randomId();
      const [w, h] = streamSize();
      const fps = Number(settings.fps);
      const bitrate = Math.round(({ 720: 6000, 900: 8000, 1080: 12000 }[settings.res] || 8000) * (fps === 30 ? 0.7 : 1));
      const runId = await dispatch({
        action: "start",
        session_id: sid,
        key_hash: hex(await sha256(key)),
        page_key: "",
        options: JSON.stringify({ gpu: settings.gpu, w, h, fps, bitrate, dpi: Number(settings.dpi), minutes: Number(settings.limit) }),
      });
      session = { sid, key, runId, at: Date.now(), gpu: settings.gpu, w, h };
      store.set("rsc.session", session);
      startLaunchView();
      followSession();
    } catch (err) {
      setHomeBanner(err.message, "error");
    } finally {
      renderHome();
    }
  }
  $("#playBtn").addEventListener("click", play);

  function startLaunchView() {
    show("launch");
    const ol = $("#progress");
    ol.innerHTML = "";
    for (const [id, label] of STEPS) {
      const li = document.createElement("li");
      li.dataset.step = id;
      li.innerHTML = `<span class="dot"></span><span></span>`;
      li.lastChild.textContent = label;
      ol.appendChild(li);
    }
    setProgress("queued", "Reserving a cloud machine…");
    banner($("#launchBanner"), session.fallback ? fallbackText() : "", "warn");
    clearInterval(launchTick);
    launchTick = setInterval(() => {
      const s = Math.max(0, Math.round((Date.now() - session.at) / 1000));
      $("#launchTimer").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 1000);
  }

  let currentPhase = "queued";
  function setProgress(phase, message, failed = false) {
    const idx = Math.max(0, STEPS.findIndex(([, , phases]) => phases.includes(phase)));
    $$("#progress li").forEach((li, i) => {
      li.className = i < idx ? "done" : i === idx ? (failed ? "failed" : phase === "ready" ? "done" : "active") : "";
    });
    $("#launchMsg").textContent = message;
  }
  const fallbackText = () => "L4 isn't available on your Google account right now, so a T4 was picked.";

  async function followSession() {
    if (following) return;
    following = true;
    let misses = 0;
    try {
      while (session && !session.ended) {
        const s = session;
        try {
          if (!s.runner) {
            const h = await findHandoff(s.runId, s.sid, (state, secs) =>
              setProgress("queued", state === "queued" ? `Waiting for a cloud machine… ${secs}s` : "Reserving a cloud machine…")
            );
            const google = store.get("rsc.google");
            if (!google) throw new Error("Sign in with Google first.");
            const res = await backendCall(h.url, "/hello", { method: "POST", key: s.key, body: seal(JSON.stringify({ key: s.key, token: google.token }), h.key) });
            if (!res.ok) throw new Error(res.error || "The cloud service did not accept the sign-in.");
            if (session !== s) return;
            s.runner = h.url;
            store.set("rsc.session", s);
          }
          const p = await backendCall(s.runner, "/progress", { key: s.key });
          if (session !== s) return;
          misses = 0;
          onProgress(p);
        } catch (err) {
          if (session !== s) return;
          const network = err instanceof TypeError || (err instanceof ApiError && err.status === 0);
          if (!network) {
            endSession(err.message, true);
            return;
          }
          // Could not reach the backend: retry for a while, then see whether it finished.
          if (++misses >= 6) {
            const run = await api(`${repoPath()}/actions/runs/${s.runId}`).catch(() => null);
            if (run && run.status === "completed") {
              endSession(s.stream ? "The session ended." : "The cloud service stopped. Try again.", !s.stream);
              return;
            }
            if (misses >= 40) {
              endSession("Lost the connection to the cloud service.", true);
              return;
            }
          }
        }
        await sleep(session && session.stream ? 10000 : 1500);
      }
    } catch (err) {
      if (session) endSession(err.message, true);
    } finally {
      following = false;
    }
  }

  function onProgress(p) {
    if (!session || session.ended) return;
    if (p.fallback && !session.fallback) {
      session.fallback = true;
      store.set("rsc.l4Unavailable", Date.now());
      if (settings.gpu === "L4") {
        settings.gpu = "T4";
        saveSettings();
      }
      banner($("#launchBanner"), fallbackText(), "warn");
      toast(fallbackText(), "warn", 9000);
    }
    if (p.gpu) session.gpu = p.gpu;
    if (p.error) {
      if (/sign in again/i.test(p.error)) store.del("rsc.google");
      setProgress(currentPhase, p.error, true);
      endSession(p.error, true);
      return;
    }
    if (p.done) {
      endSession(p.message || "The session ended.", false);
      return;
    }
    if (p.phase) {
      currentPhase = p.phase;
      setProgress(p.phase, p.message || "");
    }
    if (p.stream && session.stream !== p.stream && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(p.stream)) {
      session.stream = p.stream;
      store.set("rsc.session", session);
      openStage();
    }
  }

  async function stopSession() {
    if (!session) return;
    const s = session;
    send({ t: "stop" });
    $("#launchMsg").textContent = "Stopping…";
    let stopped = false;
    if (s.runner) {
      const r = await backendCall(s.runner, "/stop", { method: "POST", key: s.key }).catch(() => ({}));
      stopped = !!r.ok;
    }
    if (!stopped && s.runId) {
      await api(`${repoPath()}/actions/runs/${s.runId}/cancel`, { method: "POST" }).catch(() => {});
    }
    endSession("Session ended. The cloud machine is being released.", false);
  }
  $("#launchStop").addEventListener("click", stopSession);
  $("#stopBtn").addEventListener("click", () => {
    if (confirm("End this session? Save your work in Studio first (File → Save to Roblox).")) stopSession();
  });

  function endSession(message, isError) {
    if (session) session.ended = true;
    session = null;
    store.del("rsc.session");
    clearInterval(launchTick);
    closeStage();
    show("home");
    setHomeBanner(message || "The session ended.", isError ? "error" : "");
    applyGpuEligibility(false);
  }

  // ------------------------------------------------------------------- stage
  let player = null;
  let ctl = null;
  let ctlBackoff = 1;
  let serverState = {};
  let firstFrame = false;
  let wakeLock = null;
  let pingTimer, statTimer;
  let lastRtt = null;
  let soundOn = false;
  const screenEl = $("#screen");
  const controls = new Controls({
    screen: screenEl,
    touchUi: $("#touchUi"),
    stickZone: $("#stickZone"),
    stick: $("#stick"),
    knob: $("#stickKnob"),
    send: (m) => send(m),
    getCanvas: () => player && player.canvas,
    onActivity: () => {
      if (player) player.unlockSound();
      if (!$("#moreMenu").hidden) closeMenu();
    },
  });

  function openStage() {
    show("stage");
    clearInterval(launchTick);
    firstFrame = false;
    overlay("Connecting to Studio…", true);
    controls.dims = { w: session.w, h: session.h };
    setMode(settings.mode, true);
    controls.setTouchMode(settings.touchMode);
    controls.setStick(settings.stick);
    renderTouchButtons();
    if (player) player.destroy();
    player = new StreamPlayer(screenEl, {
      onFirstFrame: () => {
        firstFrame = true;
        fit();
        readyToStart();
      },
      onFallback: (why) => console.info("video: JSMpeg fallback,", why),
    });
    player.start(session.stream, session.key, { w: session.w, h: session.h, prefer: store.get("rsc.codec") });
    openCtl();
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ t: "ping", ts: performance.now() }), 2000);
    clearInterval(statTimer);
    statTimer = setInterval(updateStat, 1000);
    fadeHudSoon();
    setTimeout(() => {
      if (!firstFrame && session) overlay("Still connecting… (if this takes long, your network may block the stream)", true);
    }, 15000);
  }

  function closeStage() {
    clearInterval(pingTimer);
    clearInterval(statTimer);
    if (player) player.destroy();
    player = null;
    if (ctl) {
      const c = ctl;
      ctl = null;
      c.onclose = null;
      try {
        c.close();
      } catch {}
    }
    controls.letGo();
    if (document.pointerLockElement) document.exitPointerLock();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
    soundOn = false;
    $("#moreMenu").hidden = true;
  }

  function overlay(text, spinner = false) {
    $("#stageOverlay").hidden = !text;
    $("#overlayText").textContent = text || "";
    $("#overlaySpinner").hidden = !spinner;
    $("#tapToStart").hidden = true;
  }

  // Sound, full screen and the landscape lock need a tap or click first.
  function readyToStart() {
    $("#stageOverlay").hidden = false;
    $("#overlaySpinner").hidden = true;
    $("#overlayText").textContent = `Roblox Studio is running on the ${session && session.gpu ? session.gpu : "cloud"} GPU.`;
    $("#tapToStartText").textContent = hasTouch ? "Tap to open Studio" : "Open Studio";
    $("#tapToStart").hidden = false;
  }
  $("#tapToStart").addEventListener("click", async () => {
    overlay(null);
    if (settings.mode === "mobile" || isTouchFirst) await enterFullscreen();
    requestWakeLock();
    screenEl.focus();
  });

  async function requestWakeLock() {
    try {
      wakeLock = await navigator.wakeLock.request("screen");
    } catch {}
  }

  async function enterFullscreen() {
    const el = document.documentElement;
    try {
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" });
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      }
    } catch {}
    try {
      if (screen.orientation && screen.orientation.lock && isTouchFirst) await screen.orientation.lock("landscape");
    } catch {}
    try {
      // Lets Ctrl+W, Ctrl+N and friends reach Studio instead of the browser (Chrome and Edge).
      if (navigator.keyboard && navigator.keyboard.lock && settings.mode === "pc") await navigator.keyboard.lock();
    } catch {}
    setTimeout(fit, 300);
  }
  $("#fsBtn").addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else enterFullscreen();
  });
  document.addEventListener("fullscreenchange", () => setTimeout(fit, 100));

  function fit() {
    const c = player && player.canvas;
    if (!c) return;
    const w = c.width || session.w;
    const h = c.height || session.h;
    const sw = innerWidth;
    const sh = innerHeight;
    const s = Math.min(sw / w, sh / h);
    c.style.width = `${Math.floor(w * s)}px`;
    c.style.height = `${Math.floor(h * s)}px`;
    c.style.maxWidth = c.style.maxHeight = "none";
  }
  addEventListener("resize", fit);

  // ------------------------------------------------------------ control link
  function openCtl() {
    if (!session) return;
    const s = session;
    const ws = new WebSocket(`${s.stream.replace(/^http/, "ws")}/ctl?k=${encodeURIComponent(s.key)}`);
    ctl = ws;
    ws.onopen = () => {
      ctlBackoff = 1;
      if (firstFrame && $("#overlayText").textContent === "Reconnecting…") overlay(null);
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === "state") onServerState(m);
      else if (m.t === "cursor") setCursor(m);
      else if (m.t === "pong" && typeof m.ts === "number") lastRtt = Math.round(performance.now() - m.ts);
      else if (m.t === "clip" && m.s && navigator.clipboard) navigator.clipboard.writeText(m.s).catch(() => {});
      else if (m.t === "stopped") endSession("Session ended.", false);
    };
    ws.onclose = () => {
      if (ctl !== ws || !session || session.ended) return;
      ctl = null;
      lastRtt = null;
      if (firstFrame) overlay("Reconnecting…", true);
      setTimeout(() => session === s && !s.ended && openCtl(), Math.min(10, ctlBackoff) * 1000);
      ctlBackoff *= 2;
    };
  }
  function send(m) {
    if (ctl && ctl.readyState === 1) ctl.send(JSON.stringify(m));
  }

  function onServerState(m) {
    const was = serverState;
    serverState = m;
    if (m.w && m.h) controls.dims = { w: m.w, h: m.h };
    if (m.restarting) overlay("Restarting Roblox Studio…", true);
    else if (was.restarting) overlay(null);
    $("#soundBtn").hidden = m.audio === false;
  }

  function setCursor(m) {
    if (settings.mode !== "pc") {
      screenEl.style.cursor = "";
      return;
    }
    if (m.hidden) screenEl.style.cursor = "none";
    else if (m.png) screenEl.style.cursor = `url(data:image/png;base64,${m.png}) ${m.hx} ${m.hy}, default`;
  }

  function updateStat() {
    if (!player) return;
    const parts = [];
    if (session && session.gpu) parts.push(session.gpu);
    if (player.frames) parts.push(`${player.fps} fps`);
    if (lastRtt !== null) parts.push(`${lastRtt} ms`);
    $("#hudStat").textContent = parts.join(" · ");
    $("#menuInfo").textContent =
      `Picture ${controls.dims.w}×${controls.dims.h}, ${player.codec === "h264" ? "H.264 (hardware decoding)" : "MPEG-1 (compatibility mode)"}, ` +
      `${(player.kbps / 1000).toFixed(1)} Mbit/s` +
      (serverState.encoder ? `, encoded on the ${serverState.encoder === "nvenc" ? "GPU" : "CPU"}` : "") + ".";
    const stale = performance.now() - player.lastFrameAt > 8000;
    if (firstFrame && stale && $("#stageOverlay").hidden) overlay("Reconnecting…", true);
    else if (firstFrame && !stale && $("#overlayText").textContent === "Reconnecting…") overlay(null);
  }

  // HUD fades after a while; touching the top of the screen brings it back.
  let hudTimer;
  function fadeHudSoon() {
    clearTimeout(hudTimer);
    $("#hud").classList.remove("faded");
    hudTimer = setTimeout(() => {
      if ($("#moreMenu").hidden) $("#hud").classList.add("faded");
    }, 4000);
  }
  $("#hud").addEventListener("pointerdown", fadeHudSoon);

  function closeMenu() {
    $("#moreMenu").hidden = true;
    $("#moreBtn").setAttribute("aria-expanded", "false");
    fadeHudSoon();
  }
  $("#moreBtn").addEventListener("click", () => {
    const open = $("#moreMenu").hidden;
    $("#moreMenu").hidden = !open;
    $("#moreBtn").setAttribute("aria-expanded", String(open));
    fadeHudSoon();
    updateStat();
    $("#soundBtn").textContent = soundOn ? "Sound off" : "Sound on";
  });
  $("#restartBtn").addEventListener("click", () => {
    if (!confirm("Restart Roblox Studio? Unsaved work is lost.")) return;
    send({ t: "restart" });
    closeMenu();
    overlay("Restarting Roblox Studio…", true);
  });
  $("#soundBtn").addEventListener("click", () => {
    if (!player) return;
    soundOn = !soundOn;
    player.setSound(soundOn);
    $("#soundBtn").textContent = soundOn ? "Sound off" : "Sound on";
  });
  $$("[data-combo]").forEach((b) =>
    b.addEventListener("click", () => {
      const keys = b.dataset.combo.split("+");
      const k = keys.pop();
      send({ t: "key", k, mods: keys });
    })
  );
  $("#pasteBtn").addEventListener("click", () => {
    closeMenu();
    $("#pasteText").value = "";
    $("#pasteDialog").showModal();
    setTimeout(() => $("#pasteText").focus(), 50);
  });
  $("#pasteDialog").addEventListener("close", () => {
    const text = $("#pasteText").value;
    if ($("#pasteDialog").returnValue === "send" && text) send({ t: "paste", s: text });
    screenEl.focus();
  });

  // Mobile controls' buttons
  function renderTouchButtons() {
    $$("[data-touch]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.touch === settings.touchMode)));
    $("#stickToggle").classList.toggle("on", !!settings.stick);
  }
  $$("[data-touch]").forEach((b) =>
    b.addEventListener("click", () => {
      settings.touchMode = b.dataset.touch;
      saveSettings();
      controls.setTouchMode(settings.touchMode);
      renderTouchButtons();
    })
  );
  $("#stickToggle").addEventListener("click", () => {
    settings.stick = !settings.stick;
    saveSettings();
    controls.setStick(settings.stick);
    renderTouchButtons();
  });
  $("#rclickBtn").addEventListener("click", () => controls.setNextRight(!controls.nextRight));

  // The phone's keyboard, through a hidden text box. What changed in the box is
  // sent as text and Backspaces, so autocorrect and swipe typing work too.
  const softKb = $("#softKb");
  const PREFIX = "  ";
  let kbLast = PREFIX;
  let composing = false;
  softKb.value = PREFIX;
  function kbDiff() {
    const v = softKb.value;
    let c = 0;
    while (c < kbLast.length && c < v.length && kbLast[c] === v[c]) c++;
    for (let i = 0; i < kbLast.length - c; i++) send({ t: "key", k: "Backspace" });
    const added = v.slice(c);
    if (added) {
      added.split("\n").forEach((part, i, all) => {
        if (part) send({ t: "text", s: part });
        if (i < all.length - 1) send({ t: "key", k: "Enter" });
      });
    }
    kbLast = v;
    if (!composing && (v.length < PREFIX.length || v.length > 60 || !v.startsWith(PREFIX))) softKb.value = kbLast = PREFIX;
  }
  softKb.addEventListener("input", kbDiff);
  softKb.addEventListener("compositionstart", () => (composing = true));
  softKb.addEventListener("compositionend", () => {
    composing = false;
    kbDiff();
  });
  softKb.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      send({ t: "key", k: "Enter" });
    } else if (e.key === "Escape") softKb.blur();
    else if (e.key === "Tab") {
      e.preventDefault();
      send({ t: "key", k: "Tab" });
    }
  });
  $("#kbBtn").addEventListener("click", () => {
    if (document.activeElement === softKb) softKb.blur();
    else {
      softKb.value = kbLast = PREFIX;
      softKb.focus();
    }
  });

  addEventListener("blur", () => controls.letGo());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) controls.letGo();
    else if (!wakeLock && !$("#stage").hidden) requestWakeLock();
  });

  // --------------------------------------------------------------- settings
  function renderSettings() {
    $$("[data-res]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.res === settings.res)));
    $$("[data-fps]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.fps === settings.fps)));
    $("#dpiSelect").value = String(settings.dpi);
    $("#limitSelect").value = String(settings.limit);
    $("#accessSection").hidden = !!CFG.token;
    $("#accessInput").value = "";
    $("#accessInput").placeholder = store.get("rsc.access") ? "Saved (type to replace)" : "Not set";
    const g = store.get("rsc.google");
    $("#settingsGoogle").textContent = g ? `Signed in${g.email ? " as " + g.email : ""}.` : "Not signed in.";
    $("#signOut").disabled = !g;
  }
  $("#settingsBtn").addEventListener("click", () => {
    renderSettings();
    setMsg($("#accessMsg"), "");
    $("#settings").showModal();
  });
  $("#moreSettings").addEventListener("click", () => $("#settingsBtn").click());
  $$("[data-res]").forEach((b) =>
    b.addEventListener("click", () => {
      settings.res = b.dataset.res;
      saveSettings();
      renderSettings();
      renderHome();
    })
  );
  $$("[data-fps]").forEach((b) =>
    b.addEventListener("click", () => {
      settings.fps = b.dataset.fps;
      saveSettings();
      renderSettings();
      renderHome();
    })
  );
  $("#dpiSelect").addEventListener("change", (e) => {
    settings.dpi = e.target.value;
    saveSettings();
  });
  $("#limitSelect").addEventListener("change", (e) => {
    settings.limit = e.target.value;
    saveSettings();
  });
  $("#saveAccess").addEventListener("click", async () => {
    const v = $("#accessInput").value.trim();
    const msg = $("#accessMsg");
    if (!v) return setMsg(msg, "Paste the access key first.", "error");
    const old = store.get("rsc.access");
    store.set("rsc.access", v);
    setMsg(msg, "Checking…");
    try {
      await api(`${repoPath()}/actions/workflows/${WORKFLOW}`);
      setMsg(msg, "Saved. The key works.", "ok");
      renderSettings();
      renderHome();
    } catch (err) {
      if (old) store.set("rsc.access", old);
      else store.del("rsc.access");
      setMsg(msg, err.message, "error");
    }
  });
  $("#signOut").addEventListener("click", signOut);
  $("#forget").addEventListener("click", () => {
    if (!confirm("Forget your sign-in and settings on this device?")) return;
    for (const k of ["rsc.settings", "rsc.access", "rsc.google", "rsc.pkce", "rsc.session", "rsc.l4Unavailable", "rsc.codec"]) store.del(k);
    location.reload();
  });
  $("#settings").addEventListener("close", () => renderHome());

  // ------------------------------------------------------------------ start
  // Opened on another device (or to try the stream on its own):
  // #join=<stream address>&k=<session key>[&w=..&h=..]. The part after # never
  // reaches a server, and it is removed from the address bar once read.
  const shared = new URLSearchParams(location.hash.slice(1));
  if (shared.get("join") && shared.get("k") && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(shared.get("join"))) {
    history.replaceState(null, "", location.pathname + location.search);
    session = {
      sid: "shared",
      key: shared.get("k"),
      at: Date.now(),
      gpu: "",
      w: Number(shared.get("w")) || 1600,
      h: Number(shared.get("h")) || 900,
      stream: shared.get("join"),
      shared: true,
    };
    if (shared.get("codec")) store.set("rsc.codec", shared.get("codec"));
    openStage();
  }
  renderHome();
  applyGpuEligibility(false);
  if (session && session.shared) {
    // from a join link
  } else if (session && Date.now() - session.at < 6 * 3600e3) {
    if (session.stream) openStage();
    else startLaunchView();
    followSession();
  } else if (session) {
    session = null;
    store.del("rsc.session");
  }
  window.__rsc = { settings, store, get session() { return session; }, get player() { return player; }, controls }; // for debugging
})();
