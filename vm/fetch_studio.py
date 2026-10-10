#!/usr/bin/env python3
"""Download the current Roblox Studio (Windows x64) build straight from Roblox's
deployment CDN and lay it out the way the official installer does.

Usage: python3 02_fetch_studio.py <install_dir>

Each package zip in rbxPkgManifest.txt is md5-checked and extracted into the
folder the installer uses (same table as the Bloxstrap / Vinegar launchers).
Note: rbxManifest.txt is *not* usable for this - it lists paths flattened
(e.g. Qt5\\platforms at the root although Studio's embedded qt.conf expects
Plugins\\Qt5), so the folder table below is authoritative.
"""
import concurrent.futures
import hashlib
import io
import json
import os
import sys
import urllib.request
import zipfile

CDN = "https://setup.rbxcdn.com"
VERSION_API = "https://clientsettingscdn.roblox.com/v2/client-version/WindowsStudio64"

PACKAGE_DIRS = {
    "RobloxStudio.zip": "", "redist.zip": "", "Libraries.zip": "",
    "LibrariesQt5.zip": "", "WebView2.zip": "",
    "WebView2RuntimeInstaller.zip": "WebView2RuntimeInstaller/",
    "ApplicationConfig.zip": "ApplicationConfig/", "Plugins.zip": "Plugins/",
    "BuiltInPlugins.zip": "BuiltInPlugins/",
    "BuiltInStandalonePlugins.zip": "BuiltInStandalonePlugins/",
    "StudioFonts.zip": "StudioFonts/", "shaders.zip": "shaders/",
    "ssl.zip": "ssl/", "Qml.zip": "Qml/", "RibbonConfig.zip": "RibbonConfig/",
    "content-platform-fonts.zip": "PlatformContent/pc/fonts/",
    "content-platform-dictionaries.zip": "PlatformContent/pc/shared_compression_dictionaries/",
    "content-terrain.zip": "PlatformContent/pc/terrain/",
    "content-textures3.zip": "PlatformContent/pc/textures/",
    "content-textures2.zip": "content/textures/",
    "content-api-docs.zip": "content/api_docs/",
}


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read()


def package_dir(name):
    if name in PACKAGE_DIRS:
        return PACKAGE_DIRS[name]
    stem = name[:-4]
    for prefix, root in (("content-", "content/"), ("extracontent-", "ExtraContent/"),
                         ("studiocontent-", "StudioContent/")):
        if stem.startswith(prefix):
            return root + stem[len(prefix):] + "/"
    print(f"  (unknown package {name}, extracting to the root)")
    return ""


def main():
    install_dir = sys.argv[1]
    info = json.loads(get(VERSION_API))
    version = info["clientVersionUpload"]
    print(f"Studio {info['version']} ({version})", flush=True)

    pkg_lines = get(f"{CDN}/{version}-rbxPkgManifest.txt").decode().split()
    assert pkg_lines[0] == "v0", pkg_lines[0]
    packages = [(pkg_lines[i], pkg_lines[i + 1]) for i in range(1, len(pkg_lines), 4)]
    os.makedirs(install_dir, exist_ok=True)

    def fetch(pkg):
        name, md5 = pkg
        data = get(f"{CDN}/{version}-{name}")
        assert hashlib.md5(data).hexdigest() == md5, f"md5 mismatch for {name}"
        return name, data

    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        for name, data in pool.map(fetch, packages):
            sub = package_dir(name)
            dest = os.path.join(install_dir, sub)
            zf = zipfile.ZipFile(io.BytesIO(data))
            for item in zf.infolist():
                rel = item.filename.replace("\\", "/").lstrip("/")
                target = os.path.join(dest, rel)
                if item.is_dir() or not rel or rel.endswith("/"):
                    os.makedirs(target, exist_ok=True)
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, "wb") as f:
                    f.write(zf.read(item))
            print(f"  {name:40s} -> {sub or '.'} ({len(data) // 1024} KiB)", flush=True)

    with open(os.path.join(install_dir, "AppSettings.xml"), "w") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\r\n<Settings>\r\n'
                '\t<ContentFolder>content</ContentFolder>\r\n'
                '\t<BaseUrl>http://www.roblox.com</BaseUrl>\r\n</Settings>\r\n')
    with open(os.path.join(install_dir, "version.txt"), "w") as f:
        f.write(version)
    for must in ("RobloxStudioBeta.exe", "Plugins/Qt5/platforms/qwindows.dll"):
        assert os.path.exists(os.path.join(install_dir, must)), f"{must} missing"
    print("FETCH_DONE", os.path.join(install_dir, "RobloxStudioBeta.exe"))


if __name__ == "__main__":
    main()
