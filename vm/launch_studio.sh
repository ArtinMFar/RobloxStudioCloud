#!/usr/bin/env bash
# Starts the virtual display and Roblox Studio on it, rendered on the NVIDIA GPU
# (Direct3D 11 -> Vulkan through DXVK) inside a Wine virtual desktop that is
# exactly the size of the stream.
#
# Usage: launch_studio.sh [--restart]
# Reads WIDTH, HEIGHT, DPI and DISPLAY from /content/rsc/display.env.
set -uo pipefail
. /content/rsc/display.env

export DISPLAY
export XDG_RUNTIME_DIR=/tmp/xdg-root
export WINEPREFIX=/content/wineprefix
export WINEARCH=win64
export WINEDEBUG=-all
export WINEDLLOVERRIDES="winemenubuilder.exe=;mscoree=;mshtml="
export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/nvidia_icd.json
export __GL_SHADER_DISK_CACHE_PATH=/tmp/glcache
export DXVK_LOG_PATH=/content/logs
export DXVK_STATE_CACHE_PATH=/tmp
export DXVK_HUD=${DXVK_HUD:-}
export PULSE_SERVER=unix:/tmp/pulse/native
LOG=/content/logs
mkdir -p "$XDG_RUNTIME_DIR" $LOG /tmp/glcache && chmod 700 "$XDG_RUNTIME_DIR"

if [ "${1:-}" = "--restart" ]; then
  wineserver -k 2>/dev/null
  sleep 2
fi

# 1) The virtual screen, exactly the stream's size. MIT-SHM stays on: everything
#    here runs as root, so ffmpeg's x11grab can use shared memory.
if ! xdpyinfo >/dev/null 2>&1; then
  nohup Xvfb "$DISPLAY" -screen 0 "${WIDTH}x${HEIGHT}x24" +extension GLX +render -noreset -nolisten tcp \
    > $LOG/xvfb.log 2>&1 &
  for _ in $(seq 40); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.25; done
fi
xset r off 2>/dev/null  # key repeats come from the browser

# 2) Wine prefix as Windows 10, with DXVK instead of Wine's D3D11 (-> OpenGL).
if [ ! -f "$WINEPREFIX/.rsc-ready" ]; then
  wineboot -i > $LOG/wineboot.log 2>&1
  wineserver -w
  wine reg add 'HKCU\Software\Wine' /v Version /d win10 /f > /dev/null 2>&1
  for dll in d3d11 dxgi d3d10core d3d9; do
    cp -f "/opt/dxvk/x64/$dll.dll" "$WINEPREFIX/drive_c/windows/system32/$dll.dll"
    wine reg add 'HKCU\Software\Wine\DllOverrides' /v "$dll" /d native /f > /dev/null 2>&1
  done
  # No taskbar/start menu in the virtual desktop: Studio gets the whole screen.
  wine reg add 'HKCU\Software\Wine\Explorer\Desktops' /v Studio /d "${WIDTH}x${HEIGHT}" /f > /dev/null 2>&1
  wine reg add 'HKCU\Software\Wine\Explorer' /v EnableShell /t REG_DWORD /d 0 /f > /dev/null 2>&1
  wineserver -w
  touch "$WINEPREFIX/.rsc-ready"
fi
# Interface size (Windows DPI): 96 = 100 %, 120 = 125 %, 144 = 150 %.
wine reg add 'HKCU\Control Panel\Desktop' /v LogPixels /t REG_DWORD /d "${DPI:-96}" /f > /dev/null 2>&1
wine reg add 'HKLM\System\CurrentControlSet\Hardware Profiles\Current\Software\Fonts' /v LogPixels /t REG_DWORD /d "${DPI:-96}" /f > /dev/null 2>&1

# 3) Studio where the installer would put it, on the D3D11 renderer.
VERSION=$(cat /content/RobloxStudio/version.txt 2>/dev/null || ls "$WINEPREFIX/drive_c/Program Files/Roblox/Versions" | head -1)
DEST="$WINEPREFIX/drive_c/Program Files/Roblox/Versions/$VERSION"
if [ ! -d "$DEST" ]; then
  mkdir -p "$(dirname "$DEST")" && cp -al /content/RobloxStudio "$DEST" 2>/dev/null || cp -a /content/RobloxStudio "$DEST"
fi
mkdir -p "$DEST/ClientSettings"
cat > "$DEST/ClientSettings/ClientAppSettings.json" <<'J'
{"FFlagDebugGraphicsPreferD3D11": true}
J

# 4) Launch in a virtual desktop that fills the screen (vm/streamer.py maximises
#    Studio's window once it is up: "start /max" marks it maximised before
#    Studio has sized it, and it stays small).
LOGDIR="$WINEPREFIX/drive_c/users/root/AppData/Local/Roblox/logs"
start_studio() {
  cd "$DEST"
  nohup wine explorer /desktop=Studio,"${WIDTH}x${HEIGHT}" \
    "C:\\Program Files\\Roblox\\Versions\\$VERSION\\RobloxStudioBeta.exe" > $LOG/studio.log 2>&1 &
}

# Studio's sign-in page (with "Use another device" quick sign-in) is an
# experiment, "LoginPageExperiment", shown to installs whose
# RobloxStudioMachineGuid lands in the first rolloutPercent (50) of 100 buckets:
# bucket = (last 4 bytes of MD5(guid), big-endian) % 100. The other installs get
# an older sign-in dialog built on Microsoft WebView2, which cannot run under
# Wine and fails with "Launch Failed ... Login via Browser". So the prefix gets
# a random GUID from the first 20 buckets before Studio first starts, and Studio's
# own log is checked to be sure.
GUID_KEY='HKCU\Software\Roblox\RobloxStudio\RobloxStudioLaunchTrackingGuid\https:\www.roblox.com'
seed_guid() {
  local guid
  guid=$(python3 -c '
import hashlib, uuid
while True:
    g = str(uuid.uuid4()).upper()
    if int.from_bytes(hashlib.md5(g.encode()).digest()[-4:], "big") % 100 < 20:
        print(g)
        break')
  wine reg add "$GUID_KEY" /v RobloxStudioMachineGuid /d "$guid" /f > /dev/null 2>&1
}
login_page_check() {  # true / false / unknown, from the Studio log written after $1
  local since=$1 f line
  for _ in $(seq 60); do
    f=$(find "$LOGDIR" -maxdepth 1 -name '*Studio*.log' -newer "$since" 2>/dev/null | head -1)
    if [ -n "$f" ]; then
      line=$(grep -m1 'isInLoginPageTreatment:' "$f")
      case "$line" in
        *inTreatment=true*) echo true; return ;;
        *inTreatment=false*|*control*) echo "false (${line##*isInLoginPageTreatment: })"; return ;;
      esac
    fi
    sleep 0.5
  done
  echo unknown
}

if [ "${1:-}" = "--restart" ] || [ -f "$WINEPREFIX/.rsc-login-page" ]; then
  start_studio
else
  for attempt in 1 2 3; do
    [ "$attempt" -gt 1 ] && { wineserver -k 2>/dev/null; sleep 1; }
    seed_guid
    mkdir -p "$LOGDIR"; touch $LOG/.studio-start
    start_studio
    pick=$(login_page_check $LOG/.studio-start)
    echo "Studio sign-in page: $pick"
    case "$pick" in false*) ;; *) break ;; esac
  done
  touch "$WINEPREFIX/.rsc-login-page"
fi
echo "Studio launched on $DISPLAY (${WIDTH}x${HEIGHT}, ${DPI:-96} dpi)"
