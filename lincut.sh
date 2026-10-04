#!/usr/bin/env bash
# Запуск LinCut
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
export CHROME_DESKTOP=lincut.desktop
exec electron "$DIR" --class=LinCut "$@"
