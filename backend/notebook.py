#!/usr/bin/env python3
"""Builds the Colab notebook a session runs: every file in vm/ written with
%%writefile, the session's settings, then a cell that starts vm/setup.py in the
background and one that follows its progress.

The setup runs as its own process (not inside the cell) so that a dropped
connection to the kernel never stops it: FOLLOW can be run again on its own to
pick the progress up where it left off.

Usage: notebook.py <out.ipynb> '<settings json>'   (or import build())
"""
import json
import pathlib
import sys
import uuid

ROOT = pathlib.Path(__file__).resolve().parent.parent
VM = ROOT / "vm"
FILES = ["install.sh", "install_browser.sh", "fetch_studio.py", "launch_studio.sh", "open_url.sh", "streamer.py",
         "setup.py"]

# Prints the setup's log lines as "~<n> <line>" (n counts from 1) from line SKIP+1
# on, until it is ready, fails or stops.
FOLLOW = r'''
import os, subprocess, time
SKIP = {skip}
LOG = "/content/logs/setup.log"
n, done, deadline = 0, False, time.time() + 3000
while not done and time.time() < deadline:
    try:
        text = open(LOG, errors="replace").read()
    except OSError:
        text = ""
    complete = text.split("\n")[:-1]  # the last piece may still be being written
    for line in complete[n:]:
        n += 1
        if n > SKIP:
            print(f"~{{n}} {{line}}", flush=True)
        if line.startswith("@@READY") or line.startswith("@@STATUS error"):
            done = True
    if not done:
        if subprocess.run(["pgrep", "-f", "[/]content/rsc/setup.py"], capture_output=True).returncode != 0:
            time.sleep(1)
            if n == len(open(LOG, errors="replace").read().split("\n")[:-1]):
                print(f"~{{n + 1}} @@STATUS error The setup stopped unexpectedly", flush=True)
                done = True
        time.sleep(1)
'''


def md(text):
    return {"cell_type": "markdown", "id": uuid.uuid4().hex[:8], "metadata": {},
            "source": text.strip("\n").splitlines(True)}


def code(text):
    return {"cell_type": "code", "id": uuid.uuid4().hex[:8], "metadata": {}, "execution_count": None, "outputs": [],
            "source": text.strip("\n").splitlines(True)}


def build(settings):
    cells = [
        md("""
# Roblox Studio Cloud session

Built by the session workflow (`.github/workflows/session.yml`) for one session.
It turns this GPU machine into a Roblox Studio machine (Wine + DXVK on the NVIDIA
GPU), starts Studio on a virtual screen and streams it to the page.
"""),
        code("""
# @title Check the GPU
import os, subprocess
os.makedirs("/content/rsc", exist_ok=True)
os.makedirs("/content/logs", exist_ok=True)
print(subprocess.run("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader", shell=True,
                     capture_output=True, text=True).stdout)
"""),
    ]
    for name in FILES:
        cells.append(code(f"%%writefile /content/rsc/{name}\n" + (VM / name).read_text()))
    cells += [
        code(f"""
# @title Session settings
import json
json.dump({json.dumps(settings)}, open("/content/rsc/config.json", "w"))
"""),
        code("""
# @title Start the setup (in the background)
import subprocess
subprocess.run("chmod +x /content/rsc/*.sh; pkill -f '[/]content/rsc/setup.py'", shell=True)
subprocess.Popen(["python3", "-u", "/content/rsc/setup.py", "/content/rsc/config.json"],
                 stdout=open("/content/logs/setup.log", "w"), stderr=subprocess.STDOUT,
                 stdin=subprocess.DEVNULL, start_new_session=True)
print("setup started")
"""),
        code("# @title Follow the setup\n" + FOLLOW.format(skip=0)),
    ]
    return {
        "nbformat": 4, "nbformat_minor": 5,
        "metadata": {
            "accelerator": "GPU",
            "colab": {"provenance": [], "gpuType": settings.get("gpu", "T4"), "name": "studio_session.ipynb"},
            "kernelspec": {"name": "python3", "display_name": "Python 3"},
            "language_info": {"name": "python"},
        },
        "cells": cells,
    }


def follow_script(skip):
    return FOLLOW.format(skip=skip)


if __name__ == "__main__":
    out = pathlib.Path(sys.argv[1])
    out.write_text(json.dumps(build(json.loads(sys.argv[2] if len(sys.argv) > 2 else "{}")), indent=1) + "\n")
    print("wrote", out)
