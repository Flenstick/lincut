#!/bin/bash
# Скачивает программы для Windows-сборки в vendor/win: ffmpeg + ffprobe (BtbN, GPL, с rubberband и vidstab),
# yt-dlp.exe и uv.exe (ставит окружение Python для нейросетей). Запуск: build/fetch-win-bins.sh
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=vendor/win
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"
echo "ffmpeg…"
curl -fL --retry 3 -o "$TMP/ff.zip" https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip
unzip -q "$TMP/ff.zip" -d "$TMP/ff"
cp "$TMP"/ff/*/bin/{ffmpeg.exe,ffprobe.exe,*.dll} "$OUT"/
cp "$TMP"/ff/*/LICENSE.txt "$OUT"/FFMPEG-LICENSE.txt 2>/dev/null || true
echo "yt-dlp…"
curl -fL --retry 3 -o "$OUT/yt-dlp.exe" https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe
echo "uv…"
curl -fL --retry 3 -o "$TMP/uv.zip" https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip
unzip -q -o "$TMP/uv.zip" -d "$TMP/uv"
cp "$(find "$TMP/uv" -name uv.exe | head -1)" "$OUT"/
ls -la "$OUT"
du -sh "$OUT"
