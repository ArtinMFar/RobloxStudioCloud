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
    # Inside Studio's virtual desktop (vm/launch_studio.sh), like Studio itself:
    # a window it opens outside it would sit on the bare screen, unframed and
    # never maximised (vm/streamer.py only looks inside the desktop).
    nohup wine explorer /desktop=Studio,"${WIDTH}x${HEIGHT}" \
      "C:\\Program Files\\Roblox\\Versions\\$VERSION\\RobloxStudioBeta.exe" "$URL" >> /content/logs/studio_url.log 2>&1 &
    sleep 3
    pkill -f '[c]hrome.*rsc-chrome' || true
    ;;
  *)
    # Chrome is installed in the background after the start; wait for it if needed.
    for _ in $(seq 120); do command -v google-chrome >/dev/null && break; sleep 1; done
    # Chrome takes the window's size and place in scaled units (pixels / scale);
    # vm/streamer.py also centres the window on the screen once it is up.
    SCALE=$(python3 -c "print(round(${DPI:-96}/96, 2))")
    read -r W H X Y < <(python3 -c "s=$SCALE; W,H=$WIDTH/s,$HEIGHT/s; w,h=int(W*.94),int(H*.94); print(w,h,int((W-w)/2),int((H-h)/2))")
    # --app: a plain window without tabs or address bar; --test-type: no warning bar about --no-sandbox.
    nohup google-chrome --no-sandbox --test-type --user-data-dir=/tmp/rsc-chrome --no-first-run \
      --no-default-browser-check --disable-features=Translate,MediaRouter --password-store=basic \
      --force-device-scale-factor="$SCALE" --window-position="$X,$Y" --window-size="$W,$H" \
      --app="$URL" >> /content/logs/chrome_run.log 2>&1 &
    ;;
esac
