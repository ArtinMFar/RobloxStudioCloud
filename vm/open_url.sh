#!/usr/bin/env bash
# Opens what Studio (through Wine's winebrowser -> xdg-open) or Chrome hands over:
#   roblox-studio-auth:/...   the end of Studio's browser sign-in: give it to Studio
#                             and close the sign-in browser
#   roblox-studio:...         a "open in Studio" link: same
#   anything else             Google Chrome, on Studio's display
. /content/rsc/display.env
export DISPLAY
URL="$1"
case "$URL" in  # (a sign-in's code is not logged)
  http*) echo "$(date +%T) $URL" >> /content/logs/open_url.log ;;
  *) echo "$(date +%T) ${URL%%\?*}" >> /content/logs/open_url.log ;;
esac

case "$URL" in
  roblox-studio-auth:*|roblox-studio:*)
    export WINEPREFIX=/content/wineprefix WINEDEBUG=-all
    VERSION=$(cat /content/RobloxStudio/version.txt)
    cd "$WINEPREFIX/drive_c/Program Files/Roblox/Versions/$VERSION"
    nohup wine RobloxStudioBeta.exe "$URL" >> /content/logs/studio_url.log 2>&1 &
    sleep 3
    pkill -f '[c]hrome.*rsc-chrome' || true
    ;;
  *)
    # Chrome is installed in the background after the start; wait for it if needed.
    for _ in $(seq 120); do command -v google-chrome >/dev/null && break; sleep 1; done
    W=$(( WIDTH * 85 / 100 )); H=$(( HEIGHT * 90 / 100 ))
    # --app: a plain window without tabs or address bar; --test-type: no warning bar about --no-sandbox.
    nohup google-chrome --no-sandbox --test-type --user-data-dir=/tmp/rsc-chrome --no-first-run \
      --no-default-browser-check --disable-features=Translate,MediaRouter --password-store=basic \
      --force-device-scale-factor="$(python3 -c "print(round(${DPI:-96}/96, 2))")" \
      --window-position=$(( (WIDTH - W) / 2 )),$(( (HEIGHT - H) / 2 )) --window-size=$W,$H \
      --app="$URL" >> /content/logs/chrome_run.log 2>&1 &
    ;;
esac
