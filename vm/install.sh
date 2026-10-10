#!/usr/bin/env bash
# Turns a fresh Colab GPU VM into a Roblox Studio machine:
#   - registers the NVIDIA Vulkan/EGL drivers Colab ships in /usr/lib64-nvidia
#     but never registers (so DXVK renders on the GPU, not the CPU)
#   - Wine-staging (WineHQ) + DXVK (Direct3D 11 -> Vulkan)
#   - Xvfb, PulseAudio, xdotool, xclip
#   - cloudflared and the streamer's Python packages
# Google Chrome (only for Studio's browser sign-in) is downloaded here and
# installed later, in the background, by install_browser.sh.
# Usage: install.sh   (prints INSTALL_DONE at the end)
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
DL=/content/dl
mkdir -p $DL

# 1) NVIDIA's Vulkan ICD + EGL vendor, so the Vulkan loader finds the GPU.
mkdir -p /usr/share/vulkan/icd.d /usr/share/glvnd/egl_vendor.d
cat > /usr/share/vulkan/icd.d/nvidia_icd.json <<'J'
{"file_format_version":"1.0.1","ICD":{"library_path":"/usr/lib64-nvidia/libGLX_nvidia.so.0","api_version":"1.4.312"}}
J
cat > /usr/share/glvnd/egl_vendor.d/10_nvidia.json <<'J'
{"file_format_version":"1.0.0","ICD":{"library_path":"/usr/lib64-nvidia/libEGL_nvidia.so.0"}}
J
echo /usr/lib64-nvidia > /etc/ld.so.conf.d/zz-nvidia.conf
ldconfig 2>/dev/null || true

# 2) Downloads that do not need apt, in the background while apt works.
(
  curl -fsSL -o $DL/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  if [ ! -x /usr/local/bin/cloudflared ]; then  # setup.py fetches it first, for an early tunnel
    curl -fsSL -o /usr/local/bin/cloudflared \
      https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
    chmod 755 /usr/local/bin/cloudflared
  fi
  DXVK_URL=$(curl -fsSL https://api.github.com/repos/doitsujin/dxvk/releases/latest \
    | python3 -c 'import sys,json; print([a["browser_download_url"] for a in json.load(sys.stdin)["assets"] if a["name"].endswith(".tar.gz") and "native" not in a["name"]][0])')
  mkdir -p /opt/dxvk && curl -fsSL "$DXVK_URL" | tar -xz -C /opt/dxvk --strip-components=1
  touch $DL/downloads.ok
) > $DL/downloads.log 2>&1 &
DOWNLOADS=$!
python3 -m pip install -q aiohttp python-xlib > $DL/pip.log 2>&1 &
PIP=$!

# 3) Wine-staging from WineHQ (it needs the i386 architecture for its dependencies).
dpkg --add-architecture i386
mkdir -pm755 /etc/apt/keyrings
curl -fsSL -o /etc/apt/keyrings/winehq-archive.key https://dl.winehq.org/wine-builds/winehq.key
. /etc/os-release
curl -fsSL -o "/etc/apt/sources.list.d/winehq-${VERSION_CODENAME}.sources" \
  "https://dl.winehq.org/wine-builds/ubuntu/dists/${VERSION_CODENAME}/winehq-${VERSION_CODENAME}.sources"
apt-get update -qq || true
wait $DOWNLOADS
test -f $DL/downloads.ok || { cat $DL/downloads.log; exit 1; }
apt-get install -y -qq --install-recommends winehq-staging
apt-get install -y -qq xvfb x11-utils x11-xserver-utils xdotool xclip imagemagick \
  pulseaudio pulseaudio-utils cabextract winbind unzip fonts-liberation fonts-dejavu-core
wait $PIP || python3 -m pip install -q aiohttp python-xlib
wine --version
ls /opt/dxvk/x64

# 4) Links Studio opens go to Chrome on this display (vm/open_url.sh). Studio signs in with OAuth:
#    the browser ends on roblox-studio-auth:/?code=..., which goes back to Studio.
mkdir -p /etc/opt/chrome/policies/managed /usr/share/applications
cat > /etc/opt/chrome/policies/managed/rsc.json <<'J'
{
  "AutoLaunchProtocolsFromOrigins": [{"protocol": "roblox-studio-auth", "allowed_origins": ["*"]},
                                     {"protocol": "roblox-studio", "allowed_origins": ["*"]}],
  "DefaultBrowserSettingEnabled": false,
  "PromptForDownloadLocation": false,
  "BrowserSignin": 0,
  "SyncDisabled": true,
  "PasswordManagerEnabled": false,
  "MetricsReportingEnabled": false
}
J
cat > /usr/share/applications/rsc-browser.desktop <<'D'
[Desktop Entry]
Type=Application
Name=Browser
Exec=/content/rsc/open_url.sh %u
MimeType=x-scheme-handler/http;x-scheme-handler/https;text/html;x-scheme-handler/roblox-studio-auth;x-scheme-handler/roblox-studio;
NoDisplay=true
D
for t in x-scheme-handler/http x-scheme-handler/https text/html x-scheme-handler/roblox-studio-auth x-scheme-handler/roblox-studio; do
  xdg-mime default rsc-browser.desktop "$t"
done
echo "INSTALL_DONE"
