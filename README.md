# Roblox Studio Cloud

Roblox Studio on a cloud GPU, in the browser, on a PC or a phone.

The site (GitHub Pages, `site/`) asks for a Google sign-in, then the
authorization code, then a GPU (**L4** or **T4**) and the controls (**PC** or
**Mobile**). **Launch Studio** starts a GitHub Action that rents a Google Colab
GPU machine, builds a notebook that installs Roblox Studio there (Windows build,
Wine + DXVK, rendered on the NVIDIA GPU), runs it, and streams Studio back to
the page. The page itself only says it is Roblox Studio on the cloud.

## Setting it up (owner, once)

1. **Turn on GitHub Pages:** *Settings → Pages → Build and deployment → Source:
   GitHub Actions*. Then *Actions → Publish the site → Run workflow*. The site is
   at `https://<owner>.github.io/<repository>/`.
2. **Access key.** The page starts the backend workflow through the GitHub API,
   which needs a token. Create a
   [fine-grained token](https://github.com/settings/personal-access-tokens/new)
   with *Repository access: Only select repositories → this repository* and
   *Repository permissions → Actions: Read and write* (nothing else). Then
   either:
   - add it as the repository secret **`SITE_TOKEN`** (*Settings → Secrets and
     variables → Actions*) and run *Publish the site* again: visitors need
     nothing. The token is readable by anyone who opens the published page, so
     give it no permission besides Actions on this repository. Someone could
     use it to start or cancel this repository's workflow runs, but not to
     change code or read secrets; or
   - keep it private and paste it into the site's *Settings → Access key* on
     each device you use.

Nothing else is needed: no secrets for Google. Every visitor signs in with
their own Google account, and their sign-in stays in their own browser.

## Using it

1. **Sign in with Google**: the same Google page the `colab` command-line
   tool uses. Allow every permission and copy the code it shows.
2. **Paste the code** and press Continue (about 30 seconds: a GitHub Action
   finishes the sign-in).
3. **Pick a GPU.** L4 needs Colab Pro or pay-as-you-go compute units; if the
   account cannot get one, T4 is picked automatically, at sign-in (from
   Colab's own list) or when Colab refuses the L4.
4. **Pick the controls**, then **Launch Studio** (about 4 minutes: half a
   minute for the GitHub Action and the GPU, then installing and starting Studio).
5. **Sign in to Roblox** inside Studio: the *Use another device* code is the
   quickest (enter it in the Roblox app or at roblox.com on a device where you
   are signed in). *Sign in* opens Roblox's login page inside the cloud screen.

### Controls

- **PC:** keyboard and mouse as in Studio. Holding the right mouse button
  captures the pointer, so turning the camera never hits the edge of the
  screen. Ctrl+V pastes your device's clipboard into Studio; text copied in
  Studio (Ctrl+C) comes back to your clipboard where the browser allows it.
  In full screen, Chrome and Edge also pass Ctrl+W/N/T to Studio.
- **Mobile:**
  - a **dynamic thumbstick** like Roblox's: touch anywhere in the lower left
    and it appears under your thumb. It flies the camera (W/A/S/D). A quick tap
    there is still a click.
  - **E / Q** buttons fly up and down.
  - **drag** anywhere else to turn the camera (a right-drag), or switch the top
    toggle to **Cursor** to drag with the left button (move parts, sliders,
    panels).
  - **tap** to click, **long-press** (or the right-click button, then a tap)
    to right-click, **pinch** to zoom, **two-finger slide** to scroll.
  - the ⌨ button opens the phone's keyboard.

The page's own buttons sit in rails beside the picture (left and right with
the phone sideways, top and bottom upright), never on it, and the picture stays
inside the screen's safe area, so all of Studio is always in view, corners
included. On phones the picture's shape is chosen to fill the room between the
rails.

The ⋯ menu has Undo/Redo/Save/Delete/Play/Stop, *Paste text…*, sound and
*Restart Studio*. Settings has the picture size (720p/900p/1080p), 60 or 30
fps, the interface size (100–150 %) and the session length. Studio's window
needs about 553 px of height at 100 % (829 px at 150 %), so at 720p the
interface is at most 125 %; at 150 % its top would be cut off.

## How it works

```
site/  (GitHub Pages)
  │  GitHub API: start .github/workflows/session.yml, read its commit status
  ▼
backend/session.py on a GitHub runner
  │  opens a Cloudflare quick tunnel of its own and announces it, with a
  │  one-time public key, in a commit status ("rsc/<session id>")
  │◄── the page: POST /hello  (Google sign-in, sealed for that key)
  │◄── the page: GET /progress, POST /stop
  │  colab new --gpu L4 (else T4)
  │  backend/notebook.py builds the session notebook from vm/
  │  colab exec -f studio_session.ipynb  (runs vm/setup.py in the background,
  │                                       follows its progress)
  ▼
Colab GPU machine
  vm/install.sh       Wine-staging, DXVK, NVIDIA Vulkan driver registration, Chrome, cloudflared
  vm/fetch_studio.py  Studio from Roblox's CDN (md5-checked)
  vm/launch_studio.sh Xvfb at the stream size, Wine prefix, Studio in a virtual desktop
  vm/streamer.py      ──wss /video, /ctl, /audio (Cloudflare quick tunnel)──► the page
```

**Streaming.** RobloxCloud (the Roblox client version of this) sent MPEG-1 at
30 fps, decoded in JavaScript. Here the NVIDIA GPU encodes H.264 itself
(`h264_nvenc`, quality-targeted VBR: a still Studio screen costs ~0.2–0.3
Mbit/s, motion is capped at the bitrate), the stream is cut into frames on the
machine and each frame is one websocket message, which the browser's own
hardware decoder (WebCodecs `VideoDecoder`) decodes onto a canvas: 60 fps, no
B-frames, so no frame waits for a later one. A new viewer gets a keyframe at
once (the encoder restarts), and a viewer that falls behind skips to a fresh
keyframe instead of piling up delay. Browsers without WebCodecs H.264 get
MPEG-1 through JSMpeg at 30 fps automatically. Capture uses MIT-SHM (everything
runs as root, so x11grab can use shared memory) and NVENC takes the BGRx frames
directly, so the 2-CPU T4 machine spends almost no CPU on video. Studio's
cursor shape is sent separately (XFixes) so the pointer has no stream delay.

**Studio's sign-in page.** Studio shows its own sign-in page (with *Use another
device*) only to installs in the "LoginPageExperiment": bucket =
last 4 bytes of MD5(`RobloxStudioMachineGuid`), big-endian, mod 100, below the
rollout (50). Everyone else gets an older dialog built on Microsoft WebView2,
which does not run under Wine ("Launch Failed … Login via Browser").
`launch_studio.sh` gives each machine a random GUID from the first 20
buckets before Studio first starts, and checks Studio's log.

**Privacy.** The repository and its Actions logs are public, so nothing about
the user is in them: the Google code and sign-in travel to the runner sealed
for its one-time key, the answer is sealed for the page's, and the run masks
them in its log. The stream only accepts the session key the page made (the
run only ever sees its SHA-256).

**Ending.** *End* in the page, closing it for 10 minutes, the session length
in Settings, or 6 hours (the longest a GitHub Action runs) releases the
machine (`colab stop`), also when the run is cancelled.

## Things to know

- Colab's free tier does not allow remote desktops or using the machine
  mainly through another web UI; a paid plan does not have that rule. GPU time
  uses the Google account's Colab compute units (a T4 measured 1.07 units an
  hour; an L4 costs several times that).
- The machine is new every session: Studio is installed again and you sign in
  to Roblox again. Save your places to Roblox (*File → Save to Roblox*).
- Colab picks the machine's region, so latency varies (test machines landed in
  the US, Europe and Singapore).

## Files

- `site/`: the page. `player.js` (WebCodecs H.264 + JSMpeg fallback),
  `controls.js` (keyboard/mouse, thumbstick and touch), `app.js` (the flow),
  `vendor/` (JSMpeg MIT, TweetNaCl.js public domain, blakejs CC0).
- `backend/`: `session.py` (the Actions side), `notebook.py` (builds the
  session notebook).
- `vm/`: what runs on the GPU machine.
- `.github/workflows/`: `session.yml` (sign-in and sessions), `pages.yml`
  (publishes the site).
