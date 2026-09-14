#!/usr/bin/env bash
# 安装项目依赖。按语言分支处理，支持「公共依赖 + 项目独有依赖」两级。
#
# 依赖约定（存在才装，按 公共 -> 独有 顺序）：
#     <语言>/requirements.txt          公共
#     <语言>/<项目>/requirements.txt   独有
#
# 输入环境变量：
#     LANG_NAME   语言目录名，如 python / php / shell
#     PROJECT     项目目录名，如 glados_checkin

set -euo pipefail

: "${LANG_NAME:?LANG_NAME 未设置}"
: "${PROJECT:?PROJECT 未设置}"

case "$LANG_NAME" in
  python)
    python -m pip install --upgrade pip >/dev/null
    for f in "${LANG_NAME}/requirements.txt" "${LANG_NAME}/${PROJECT}/requirements.txt"; do
      if [ -f "$f" ]; then
        echo "-> pip install -r $f"
        pip install -r "$f"
      fi
    done
    ;;

  php)
    if [ -f "${LANG_NAME}/${PROJECT}/composer.json" ]; then
      echo "-> composer install ($PROJECT)"
      composer install --no-interaction --no-progress
    fi
    ;;

  shell)
    echo "-> shell 项目无需安装依赖，跳过"
    ;;

  *)
    echo "-> 未知语言 '$LANG_NAME'，跳过依赖安装"
    ;;
esac

echo "依赖处理完成"
