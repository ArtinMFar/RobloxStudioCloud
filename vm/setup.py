#!/usr/bin/env python3
"""Sets up a fresh Colab GPU VM, starts Roblox Studio and the stream.

Started in the background by the session notebook (see backend/notebook.py), so
a dropped connection to the kernel never stops it. Progress goes to stdout
(the notebook's follow cell relays it) as

  @@STATUS <phase> <message>
  @@READY {"url": ..., "gpu": ...}     the stream is up
  @@STATUS error <message>             it failed

Usage: setup.py /content/rsc/config.json
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request

RSC = "/content/rsc"
LOGS = "/content/logs"
DISPLAY = ":99"
PORT = 8765
cfg = json.load(open(sys.argv[1]))
W, H = int(cfg["width"]) // 8 * 8, int(cfg["height"]) // 2 * 2


def status(phase, msg):
    print(f"@@STATUS {phase} {msg}", flush=True)


def fail(msg):
    status("error", msg)
    sys.exit(1)


def sh(cmd, timeout=900):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    return r.returncode, (r.stdout + r.stderr).strip()


def bg(cmd, log):
    return subprocess.Popen(cmd, shell=True, stdout=open(log, "w"), stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, start_new_session=True)


def tail(path, n=400):
    try:
        return open(path, errors="replace").read()[-n:]
    except OSError:
        return ""


os.makedirs(LOGS, exist_ok=True)
os.makedirs("/tmp/rsc", exist_ok=True)
t0 = time.time()

# ---------------------------------------------------------------- the GPU
status("vm", "Checking the GPU")
rc, out = sh("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader")
if rc != 0:
    fail("This machine has no GPU")
gpu = out.splitlines()[0].split(",")[0].strip().replace("Tesla ", "")
print(f"{gpu}, {os.cpu_count()} CPUs", flush=True)

# ------------------------------------------- install + Studio, side by side
status("install", "Installing the Windows layer and graphics drivers")
fetched = {}


def fetch():
    r = subprocess.run([sys.executable, f"{RSC}/fetch_studio.py", "/content/RobloxStudio"],
                       capture_output=True, text=True)
    fetched["rc"], fetched["out"] = r.returncode, r.stdout + r.stderr


studio_dl = threading.Thread(target=fetch)
studio_dl.start()
inst = bg(f"bash {RSC}/install.sh", f"{LOGS}/install.log")
while inst.poll() is None:
    time.sleep(5)
    if fetched.get("rc") == 0 and not fetched.get("said"):
        fetched["said"] = True
        print("Roblox Studio downloaded", flush=True)
    status("install", f"Installing the Windows layer and graphics drivers ({int(time.time() - t0)} s)")
if inst.returncode != 0 or "INSTALL_DONE" not in tail(f"{LOGS}/install.log", 200):
    fail("Installing failed: " + tail(f"{LOGS}/install.log", 300).replace("\n", " | "))
status("download", "Downloading Roblox Studio")
studio_dl.join()
if fetched.get("rc") != 0:
    fail("Downloading Roblox Studio failed: " + fetched.get("out", "")[-300:])
print(fetched["out"].strip().splitlines()[0], flush=True)

# ------------------------------------------------------------------ sound
os.makedirs("/tmp/pulse", exist_ok=True)
env_pulse = "PULSE_RUNTIME_PATH=/tmp/pulse PULSE_SERVER=unix:/tmp/pulse/native"
sh(f"{env_pulse} pulseaudio --daemonize=yes --exit-idle-time=-1 --disallow-exit "
   f"--log-target=file:{LOGS}/pulse.log 2>/dev/null; sleep 1")
rc, out = sh(f"{env_pulse} pactl get-default-sink")
audio_source = (out.strip().splitlines() or [""])[-1] + ".monitor" if rc == 0 and out.strip() else ""
print(f"sound: {audio_source or 'none'}", flush=True)

# ----------------------------------------------------------------- Studio
status("launch", "Starting Roblox Studio")
open(f"{RSC}/display.env", "w").write(f"DISPLAY={DISPLAY}\nWIDTH={W}\nHEIGHT={H}\nDPI={int(cfg.get('dpi', 96))}\n")
rc, out = sh(f"bash {RSC}/launch_studio.sh", 300)
print(out, flush=True)
if rc != 0:
    fail("Studio did not start: " + out[-300:])


def studio_vram():
    _, out = sh("nvidia-smi --query-compute-apps=process_name,used_memory --format=csv,noheader,nounits")
    return max([int(line.rsplit(",", 1)[1]) for line in out.splitlines() if "RobloxStudio" in line] or [0])


end = time.time() + 240
while studio_vram() < 150 and time.time() < end:  # its renderer is up on the GPU
    time.sleep(3)
if studio_vram() < 150:
    fail("Roblox Studio did not open: " + tail(f"{LOGS}/studio.log", 300).replace("\n", " | "))
status("launch", f"Roblox Studio is running on the {gpu}")

# --------------------------------------------------------------- streaming
status("stream", "Starting the stream")
json.dump({
    "port": PORT, "key_hash": cfg["key_hash"], "width": W, "height": H, "fps": int(cfg.get("fps", 60)),
    "bitrate": int(cfg.get("bitrate", 8000)), "display": DISPLAY, "state_file": "/tmp/rsc/state.json",
    "launcher": f"{RSC}/launch_studio.sh", "audio_source": audio_source, "gpu": gpu,
}, open(f"{RSC}/streamer.json", "w"))
sh("pkill -f '[/]content/rsc/streamer.py'; pkill -x cloudflared; true")
bg(f"PULSE_RUNTIME_PATH=/tmp/pulse PULSE_SERVER=unix:/tmp/pulse/native DISPLAY={DISPLAY} "
   f"{sys.executable} -u {RSC}/streamer.py {RSC}/streamer.json", f"{LOGS}/streamer.log")
for _ in range(60):
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2).read()
        break
    except OSError:
        time.sleep(0.5)
else:
    fail("The stream did not start: " + tail(f"{LOGS}/streamer.log"))

# HTTP/2 over TCP, never QUIC: Colab throttles UDP so hard that QUIC carried
# 20 KB/s where HTTP/2 carried 12 MB/s from the same VM (measured for RobloxCloud).
url = None
for attempt in range(3):
    bg(f"cloudflared tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:{PORT}", f"{LOGS}/cloudflared.log")
    end = time.time() + 45
    while time.time() < end and not url:
        m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", tail(f"{LOGS}/cloudflared.log", 100000))
        url = m.group(0) if m else None
        time.sleep(1)
    if url:
        break
    sh("pkill -x cloudflared")
if not url:
    fail("Could not open a connection to the internet: " + tail(f"{LOGS}/cloudflared.log", 300))

end = time.time() + 90  # a new quick tunnel can take a few seconds to resolve
while True:
    try:
        req = urllib.request.Request(url + "/health", headers={"User-Agent": "rsc"})
        json.loads(urllib.request.urlopen(req, timeout=10).read())
        break
    except Exception as e:
        if time.time() > end:
            fail(f"The stream's address did not answer: {e}")
        time.sleep(2)

bg(f"bash {RSC}/install_browser.sh", f"{LOGS}/browser.log")  # for Studio's browser sign-in
print(f"ready in {int(time.time() - t0)} s", flush=True)
print("@@READY " + json.dumps({"url": url, "gpu": gpu, "cpus": os.cpu_count()}), flush=True)
