#!/usr/bin/env python3
"""The backend of Roblox Studio Cloud, run by .github/workflows/session.yml.

  session.py login    finish a Google sign-in the page started
  session.py start    rent a Colab GPU machine (L4, or T4 when L4 is not
                      available), build the session notebook and run it there,
                      tell the page where the stream is, keep the machine while
                      Studio is in use, then release it
  session.py cleanup  release the machine (the workflow runs this even when the
                      run is cancelled)

How the static page and this script talk, given that the repository (and so
this run's inputs and log) is public:

1. The page starts the run with a session id, the SHA-256 of a session key
   only the page knows, and (for login) a one-time public key of its own.
2. This script opens a Cloudflare quick tunnel to a small HTTP server of its
   own and posts a commit status, context "rsc/<session id>", whose target URL
   is that address and whose description carries this run's one-time public key.
3. The page sends what it has to send (the Google code and PKCE verifier, or
   the Google sign-in for a session) to POST /hello, sealed for that key, with
   the session key inside, which proves it is the page that started the run.
   For login the answer is sealed for the page's one-time key.
4. The page follows GET /progress?k=<session key> and can POST /stop.

Nothing readable about the user (sign-in, e-mail address) appears in the run's
inputs, statuses or log.
"""
import base64
import hashlib
import hmac
import http.server
import json
import os
import pathlib
import re
import subprocess
import sys
import threading
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
import notebook  # noqa: E402

E = os.environ
SID = re.sub(r"[^a-z0-9-]", "", E.get("SESSION_ID", "local").lower())[:24] or "local"
NAME = f"rsc-{SID}"
KEY_HASH = E.get("KEY_HASH", "").strip().lower()
OPTIONS = json.loads(E.get("OPTIONS") or "{}")
STATE = pathlib.Path.home() / ".rsc-session.json"
TOKEN_PATH = pathlib.Path.home() / ".config/colab-cli/token.json"
WORK = pathlib.Path(E.get("RUNNER_TEMP", "/tmp")) / "rsc"
WORK.mkdir(parents=True, exist_ok=True)
PORT = 8790
# Studio's editor window will not get shorter than about 553 px at a 100 %
# interface size (829 px at 150 %, measured on a T4 machine); on a shorter
# screen it sticks out and its title bar and menus are cut off. So the interface
# size is lowered, if need be, to the largest that leaves Studio this much room.
STUDIO_MIN_HEIGHT = 560


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def mask(value):
    """Hide a value in the (public) Actions log from here on."""
    if value:
        for part in str(value).splitlines():
            if part.strip():
                print(f"::add-mask::{part.strip()}", flush=True)


def redact(text):
    text = re.sub(r"[\w.+-]+@[\w-]+\.[\w.-]+", "<email>", text)
    return re.sub(r"(ya29\.|1//)[\w.-]+", "<token>", text)


# --------------------------------------------------------------- GitHub
def github(method, path, body=None):
    if not E.get("GITHUB_TOKEN") or not E.get("GITHUB_REPOSITORY"):
        return None
    req = urllib.request.Request(
        f"https://api.github.com/repos/{E['GITHUB_REPOSITORY']}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {E['GITHUB_TOKEN']}", "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read() or b"null")
        except Exception as e:
            log(f"(GitHub {method} {path} failed: {e})")
            time.sleep(2 * (attempt + 1))
    return None


def status(phase, message="", url=None, key=None):
    """The commit status the page polls until it can talk to this run directly."""
    d = {"p": phase, "m": message}
    if key:
        d["k"] = key
    text = json.dumps(d, separators=(",", ":"))
    if len(text) > 140:
        d["m"] = message[: max(0, len(message) - (len(text) - 139))] + "…"
        text = json.dumps(d, separators=(",", ":"))
    run_url = f"{E.get('GITHUB_SERVER_URL', 'https://github.com')}/{E.get('GITHUB_REPOSITORY')}/actions/runs/{E.get('GITHUB_RUN_ID')}"
    state = {"error": "error", "done": "success"}.get(phase, "pending")
    github("POST", f"/statuses/{E.get('GITHUB_SHA')}", {
        "state": state, "context": f"rsc/{SID}", "description": text, "target_url": url or run_url})


# ----------------------------------------------------------- sealed boxes
def seal(text, public_key_b64):
    from nacl.public import PublicKey, SealedBox
    return base64.b64encode(SealedBox(PublicKey(base64.b64decode(public_key_b64))).encrypt(text.encode())).decode()


# --------------------------------------------------------- the page's line
class Line:
    """A small HTTP server behind a Cloudflare quick tunnel, for the page."""

    def __init__(self):
        from nacl.public import PrivateKey
        self.key = PrivateKey.generate()
        self.public = base64.b64encode(bytes(self.key.public_key)).decode()
        self.lock = threading.Lock()
        self.progress = {"phase": "handoff", "message": "Connecting"}
        self.hello = None
        self.hello_event = threading.Event()
        self.reply = None
        self.reply_event = threading.Event()
        self.stop_event = threading.Event()
        self.url = None

    def set(self, **kw):
        with self.lock:
            self.progress.update(kw)
        if kw.get("message"):
            log(f"[{self.progress.get('phase')}] {redact(kw['message'])}")

    def authorised(self, key):
        return bool(key) and hmac.compare_digest(hashlib.sha256(key.encode()).hexdigest(), KEY_HASH)

    def open_sealed(self, body):
        from nacl.public import SealedBox
        return json.loads(SealedBox(self.key).decrypt(base64.b64decode(body)).decode())

    def start(self):
        line = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def send(self, code, obj):
                data = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_OPTIONS(self):
                self.send_response(204)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Access-Control-Max-Age", "600")
                self.end_headers()

            def key(self):
                from urllib.parse import parse_qs, urlparse
                return (parse_qs(urlparse(self.path).query).get("k") or [""])[0]

            def do_GET(self):
                if self.path.startswith("/progress"):
                    if not line.authorised(self.key()):
                        return self.send(403, {"error": "wrong key"})
                    with line.lock:
                        return self.send(200, dict(line.progress))
                if self.path.startswith("/health"):
                    return self.send(200, {"ok": True})
                self.send(404, {"error": "not found"})

            def do_POST(self):
                length = min(int(self.headers.get("Content-Length") or 0), 65536)
                body = self.rfile.read(length).decode(errors="replace")
                if self.path.startswith("/hello"):
                    try:
                        msg = line.open_sealed(body.strip())
                    except Exception:
                        return self.send(400, {"ok": False, "error": "This message could not be read."})
                    if not line.authorised(str(msg.get("key", ""))):
                        return self.send(403, {"ok": False, "error": "This page did not start this session."})
                    if line.hello_event.is_set():
                        return self.send(409, {"ok": False, "error": "Already started."})
                    line.hello = msg
                    line.hello_event.set()
                    line.reply_event.wait(120)
                    return self.send(200, line.reply or {"ok": False, "error": "No answer in time."})
                if self.path.startswith("/stop"):
                    if not line.authorised(self.key()):
                        return self.send(403, {"ok": False, "error": "wrong key"})
                    line.stop_event.set()
                    return self.send(200, {"ok": True})
                self.send(404, {"error": "not found"})

        server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()

        cloudflared = WORK / "cloudflared"
        if not cloudflared.exists():
            subprocess.run(["curl", "-fsSL", "-o", str(cloudflared),
                            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"],
                           check=True)
            cloudflared.chmod(0o755)
        for attempt in range(3):
            logf = WORK / f"cloudflared-{attempt}.log"
            proc = subprocess.Popen([str(cloudflared), "tunnel", "--no-autoupdate", "--protocol", "http2",
                                     "--url", f"http://127.0.0.1:{PORT}"], stdout=open(logf, "w"),
                                    stderr=subprocess.STDOUT)
            end = time.time() + 40
            while time.time() < end and not self.url:
                m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", logf.read_text(errors="replace"))
                self.url = m.group(0) if m else None
                time.sleep(0.5)
            if self.url:
                break
            proc.kill()
        if not self.url:
            raise RuntimeError("could not open a tunnel")
        end = time.time() + 60  # a new quick tunnel takes a moment to resolve
        while time.time() < end:
            try:
                urllib.request.urlopen(urllib.request.Request(self.url + "/health", headers={"User-Agent": "rsc"}),
                                       timeout=5).read()
                break
            except Exception:
                time.sleep(1.5)
        status("handoff", "", url=self.url, key=self.public)
        log("waiting for the page")

    def wait_hello(self, timeout=300):
        if not self.hello_event.wait(timeout):
            self.fail("The page did not connect in time. Try again.", reply=False)
        return self.hello

    def answer(self, reply):
        self.reply = reply
        self.reply_event.set()

    def fail(self, error, reply=True):
        """Tell the page what went wrong (as the answer to /hello and in /progress),
        give it time to read it, and end the run."""
        if reply and not self.reply_event.is_set():
            self.answer({"ok": False, "error": error})
        self.set(phase="error", error=error)
        status("error", error)
        time.sleep(15)
        sys.exit(1)


# ---------------------------------------------------------------- login
def gpu_eligibility(creds):
    """Colab's own list of accelerators this account can get (from ccu-info,
    which `colab usage` reads); None when it does not say."""
    try:
        from colab_cli import client as cc
        from google.auth.transport.requests import AuthorizedSession
        r = AuthorizedSession(creds).get(cc.Prod().domain + "/tun/m/ccu-info", params={"authuser": "0"}, timeout=30,
                                         headers={cc.ACCEPT_JSON_HEADER["key"]: cc.ACCEPT_JSON_HEADER["value"],
                                                  cc.COLAB_CLIENT_AGENT_HEADER["key"]: cc.COLAB_CLIENT_AGENT_HEADER["value"]})
        body = r.text[len(cc.XSSI_PREFIX):] if r.text.startswith(cc.XSSI_PREFIX) else r.text
        data = json.loads(body)
    except Exception as e:
        log(f"(GPU list unavailable: {type(e).__name__})")
        return None
    eligible = [str(g).upper() for g in data.get("eligibleGpus") or []]
    if not eligible and "eligibleGpus" not in data:
        return None
    return {"eligible": eligible, "l4": any("L4" in g for g in eligible)}


def login():
    from importlib import resources

    from colab_cli import auth
    from google_auth_oauthlib.flow import InstalledAppFlow

    page_key = E.get("PAGE_KEY", "")
    line = Line()
    line.start()
    msg = line.wait_hello()
    code, verifier = str(msg.get("code", "")).strip(), str(msg.get("verifier", ""))
    mask(code)
    mask(verifier)
    log("got the sign-in code")
    client_config = json.loads(resources.files("colab_cli").joinpath("oauth_config.json").read_text())
    flow = InstalledAppFlow.from_client_config(client_config, auth.PUBLIC_SCOPES, code_verifier=verifier,
                                               autogenerate_code_verifier=False)
    flow.redirect_uri = auth.REMOTE_REDIRECT_URI
    try:
        flow.fetch_token(code=code)
    except Exception as e:
        err = str(e)
        log("Google refused the code:", "invalid_grant" if "invalid_grant" in err else type(e).__name__)
        line.fail("That code was already used or has expired. Press Sign in with Google again."
                  if "invalid_grant" in err else "Google did not accept the code. Press Sign in with Google again.")
    creds = flow.credentials
    mask(creds.token)
    mask(creds.refresh_token)
    if not creds.refresh_token:
        line.fail("Google gave no lasting sign-in. Sign in again and allow every permission.")
    granted = set(flow.oauth2session.token.get("scope") or [])
    if granted and "https://www.googleapis.com/auth/colaboratory" not in granted:
        line.fail("The Colab permission was not allowed. Sign in again and allow every permission.")
    email = None
    id_token = flow.oauth2session.token.get("id_token")
    if id_token:
        try:
            payload = id_token.split(".")[1]
            email = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))).get("email")
            mask(email)
        except (IndexError, ValueError):
            pass
    gpus = gpu_eligibility(creds)
    line.answer({"ok": True, "sealed": seal(json.dumps({"token": creds.to_json(), "email": email, "gpus": gpus}), page_key)})
    log("signed in", "(L4 available)" if gpus and gpus.get("l4") else "")
    status("done", "Signed in")
    time.sleep(3)  # let the answer reach the page


# ---------------------------------------------------------------- colab
def colab(*args, timeout=None):
    """Run the colab CLI; returns (returncode, combined output)."""
    try:
        r = subprocess.run(["colab", *args], capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL,
                           env={**os.environ, "PYTHONUNBUFFERED": "1"})
    except subprocess.TimeoutExpired:
        return 124, f"colab {args[0]} timed out"
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def explain(out):
    lines = [line.strip() for line in out.strip().splitlines() if line.strip()]
    for line in reversed(lines):
        if any(w in line.lower() for w in ("error", "denied", "quota", "unavailable", "failed", "rejected", "not available")):
            return redact(line)[:160]
    return redact(lines[-1] if lines else "no answer")[:160]


def write_token(token_json):
    try:
        data = json.loads(token_json)
    except ValueError:
        return False
    mask(data.get("token"))
    mask(data.get("refresh_token"))
    TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_PATH.write_text(token_json)
    TOKEN_PATH.chmod(0o600)
    return True


def provision(line, want):
    """Create the machine. L4 falls back to T4."""
    attempts = (["L4"] if want == "L4" else []) + ["T4"]
    out = ""
    for gpu in attempts:
        line.set(phase="gpu", gpu=gpu, message=f"Getting a{'n' if gpu == 'L4' else ''} {gpu} GPU")
        rc, out = colab("new", "-s", NAME, "--gpu", gpu, timeout=600)
        log(redact(out.strip())[-500:])
        if rc == 0 and "rejected" not in out.lower() and "error" not in out.lower():
            return gpu
        if any(s in out for s in ("invalid_grant", "Token has been expired", "401", "revoked")):
            line.set(phase="error", error="Your Google sign-in has expired. Sign in again.")
            return None
        colab("stop", "-s", NAME, timeout=120)
        if gpu == "L4":
            line.set(phase="gpu-fallback", fallback=True, gpu="T4",
                     message="L4 isn't available on this account right now, so a T4 was picked")
    line.set(phase="error", error=f"No GPU was available: {explain(out)}")
    return None


def run_setup(line, settings):
    """Build the session notebook, run it on the machine and relay its progress.
    Returns the @@READY dict, or None."""
    nb_path = WORK / "studio_session.ipynb"
    nb_path.write_text(json.dumps(notebook.build(settings), indent=1))
    log(f"built {nb_path.name} ({nb_path.stat().st_size // 1024} KiB, {len(notebook.FILES)} files)")
    seen, ready, failed = 0, None, False
    target = str(nb_path)
    for attempt in range(6):
        proc = subprocess.Popen(["colab", "exec", "-s", NAME, "--timeout", "3200", "-f", target],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, stdin=subprocess.DEVNULL,
                                env={**os.environ, "PYTHONUNBUFFERED": "1"})
        # Stop from the page while the machine is still being set up: stop following now.
        threading.Thread(target=lambda p=proc: line.stop_event.wait() and p.poll() is None and p.terminate(),
                         daemon=True).start()
        for raw in proc.stdout:
            raw = raw.rstrip("\n")
            m = re.match(r"^~(\d+) (.*)$", raw)
            if not m:
                if raw.strip():
                    log("  " + redact(raw)[:300])
                continue
            n, text = int(m.group(1)), m.group(2)
            if n <= seen:
                continue
            seen = n
            if text.startswith("@@STATUS "):
                _, phase, *rest = text.split(" ", 2)
                msg = rest[0] if rest else phase
                if phase == "error":
                    failed = True
                    line.set(phase="error", error=msg)
                else:
                    line.set(phase=phase, message=msg)
            elif text.startswith("@@READY "):
                ready = json.loads(text[len("@@READY "):])
            else:
                log("  " + redact(text)[:300])
        proc.wait()
        if ready or failed or line.stop_event.is_set():
            break
        # The connection to the kernel dropped; the setup goes on by itself. Pick its log up again.
        log(f"(lost the connection to the machine; following again, attempt {attempt + 2})")
        follow = WORK / "follow.py"
        follow.write_text(notebook.follow_script(seen))
        target = str(follow)
        time.sleep(3)
    if not ready and not failed:
        line.set(phase="error", error="Setting up the machine failed")
    return ready


def health(url):
    try:
        req = urllib.request.Request(url + "/health", headers={"User-Agent": "rsc"})
        return json.loads(urllib.request.urlopen(req, timeout=15).read())
    except Exception:
        return None


def fitting_dpi(want, height):
    """The interface size (96, 120 or 144 dpi) to use: the one asked for, or the
    largest smaller one that leaves Studio's window room on a screen this tall."""
    want = want if want in (96, 120, 144) else 96
    fits = [d for d in (96, 120, 144) if d <= want and height * 96 / d >= STUDIO_MIN_HEIGHT]
    return max(fits or [96])


def release(line, message):
    if STATE.exists():
        rc, out = colab("stop", "-s", NAME, timeout=300)
        log(redact(out.strip())[-300:])
        STATE.unlink(missing_ok=True)
    line.set(phase="done", done=True, message=message)
    status("done", "Ended")


def start():
    line = Line()
    line.start()
    msg = line.wait_hello()
    if not write_token(str(msg.get("token", ""))):
        line.fail("Sign in with Google first.")
    line.answer({"ok": True})
    STATE.write_text(json.dumps({"name": NAME}))  # from here on, cleanup releases the machine

    gpu = provision(line, str(OPTIONS.get("gpu", "L4")).upper())
    if gpu and line.stop_event.is_set():
        release(line, "Session ended")
        return
    if not gpu:
        STATE.unlink(missing_ok=True)
        line.fail(line.progress.get("error") or "No GPU was available", reply=False)
    w, h = int(OPTIONS.get("w", 1600)), int(OPTIONS.get("h", 900))
    w, h = max(1024, min(2560, w)), max(576, min(1440, h))
    settings = {
        "key_hash": KEY_HASH, "gpu": gpu, "width": w, "height": h,
        "fps": 30 if int(OPTIONS.get("fps", 60)) <= 30 else 60,
        "bitrate": max(1500, min(20000, int(OPTIONS.get("bitrate", 8000)))),
        "dpi": fitting_dpi(int(OPTIONS.get("dpi", 96)), h),
    }
    line.set(phase="vm", message="Preparing the machine")
    ready = run_setup(line, settings)
    if line.stop_event.is_set():
        release(line, "Session ended")
        return
    if not ready:
        if STATE.exists():
            colab("stop", "-s", NAME, timeout=300)
            STATE.unlink(missing_ok=True)
        line.fail(line.progress.get("error") or "Setting up the machine failed", reply=False)
    line.set(phase="ready", stream=ready["url"], gpu=ready.get("gpu", gpu),
             message=f"Roblox Studio is running on the {ready.get('gpu', gpu)}")
    status("ready", "Running")

    started = time.time()
    max_s = min(345, max(15, float(OPTIONS.get("minutes") or 120))) * 60
    idle_s = 10 * 60
    no_show_s = 5 * 60  # the page never opened the stream (closed, or replaced by another launch)
    misses = 0
    while True:
        if line.stop_event.wait(20):
            release(line, "Session ended")
            break
        st = health(ready["url"])
        if st is None:
            misses += 1
            if misses >= 9:  # three minutes without an answer
                release(line, "The cloud machine stopped answering")
                break
            continue
        misses = 0
        if st.get("stopped"):
            release(line, "Session ended")
            break
        if st.get("seen") is False and time.time() - started > no_show_s:
            release(line, "Nobody opened the session, so it ended")
            break
        if st.get("clients", 0) == 0 and st.get("idle", 0) > idle_s:
            release(line, "Nobody was connected for 10 minutes, so the session ended")
            break
        if time.time() - started > max_s:
            release(line, f"The {int(max_s // 60)}-minute session limit was reached")
            break
    time.sleep(30)  # the page reads "done" before the run ends


def cleanup():
    if STATE.exists():
        rc, out = colab("stop", "-s", NAME, timeout=300)
        log(redact(out.strip())[-300:])
        STATE.unlink(missing_ok=True)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "start"
    try:
        {"login": login, "start": start, "cleanup": cleanup}[cmd]()
    except KeyboardInterrupt:  # the run was cancelled; the cleanup step releases the machine
        sys.exit(130)
