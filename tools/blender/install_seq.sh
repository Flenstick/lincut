#!/bin/bash
# install_seq.sh <набор> <папка PNG> <alpha|black> <ширина> [качество]
set -e
NAME=$1; SRC=$2; MODE=$3; W=$4; Q=${5:-86}
DST=$HOME/Projects/lincut/src/fx/$NAME
rm -rf "$DST"; mkdir -p "$DST"
H=$((W * 9 / 16))
if [ "$MODE" = alpha ]; then
  # libwebp выбрасывает альфу у полностью непрозрачных кадров — тогда посреди потока меняется формат пикселей
  # и граф ffmpeg пересобирается со сдвигом времени. Угловой пиксель чуть прозрачный — альфа есть у всех кадров.
  TMPD=$(mktemp -d); python3 - "$SRC" "$TMPD" <<'PY'
import sys, os
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
for f in sorted(os.listdir(src)):
    im = Image.open(os.path.join(src, f)).convert('RGBA')
    px = im.load(); r, g, b, a = px[0, 0]; px[0, 0] = (r, g, b, min(a, 250))
    im.save(os.path.join(dst, f))
PY
  SRC=$TMPD
fi
if [ "$MODE" = alpha ]; then PF=yuva420p; BLANK="color=c=black@0.0:s=${W}x${H},format=rgba"; else PF=yuv420p; BLANK="color=c=black:s=${W}x${H}"; fi
ffmpeg -v error -y -start_number 0 -i "$SRC/%04d.png" -vf "scale=${W}:${H}:flags=lanczos" -c:v libwebp -quality $Q -pix_fmt $PF -f image2 -start_number 0 "$DST/%04d.webp"
ffmpeg -v error -y -f lavfi -i "$BLANK" -frames:v 1 -c:v libwebp -quality $Q -pix_fmt $PF "$DST/blank.webp"
ls "$DST" | wc -l; du -sh "$DST"
