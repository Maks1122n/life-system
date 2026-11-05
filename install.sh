#!/usr/bin/env bash
# Установка или обновление «Жизнь в порядке» на сервере.
# Запуск: bash install.sh 'твой_пароль'
# Повторный запуск обновляет сервис, твои данные в /opt/life/data не трогаются.
set -euo pipefail

PASS="${1:-}"
PORT="${PORT:-8090}"
DIR=/opt/life
REPO="${REPO:-Maks1122n/life-system}"
BRANCH="${BRANCH:-main}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo /nonexistent)"
# Запуск одной командой через curl: файлов рядом нет — скачиваем их из репозитория.
if [ ! -f "$SRC/server.js" ]; then
  SRC="$(mktemp -d)"
  RAW="https://raw.githubusercontent.com/${REPO}/${BRANCH}"
  echo "Скачиваю файлы из ${REPO}…"
  mkdir -p "$SRC/public"
  curl -fsSL "$RAW/server.js" -o "$SRC/server.js"
  curl -fsSL "$RAW/public/index.html" -o "$SRC/public/index.html"
fi

if [ "${#PASS}" -lt 8 ]; then
  echo "Укажи пароль не короче 8 символов, без пробелов и кавычек: bash install.sh 'пароль'"; exit 1
fi
case "$PASS" in *[[:space:]\"\'\\]*) echo "В пароле не должно быть пробелов, кавычек и обратной косой черты."; exit 1;; esac

# 1. Порт свободен? (если на нём уже наш сервис — это обновление)
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${PORT}\$"; then
  if ! systemctl is-active --quiet life 2>/dev/null; then
    echo "Порт ${PORT} занят другим сервисом. Запусти на другом порту: PORT=8091 bash install.sh 'пароль'"; exit 1
  fi
fi

# 2. Node.js: ставим только если его нет. Существующий не обновляем, чтобы не задеть другие сервисы.
if command -v node >/dev/null 2>&1; then
  MAJ=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$MAJ" -lt 18 ]; then
    echo "На сервере уже стоит Node.js $(node -v), а нужен 18+."
    echo "Обновлять его скрипт не будет: им может пользоваться другой сервис. Ничего не изменено."; exit 1
  fi
  echo "Node.js $(node -v) уже есть."
else
  echo "Ставлю Node.js 20…"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
NODE_BIN="$(command -v node)"

# 3. Файлы
mkdir -p "$DIR/public"
cp "$SRC/server.js" "$DIR/server.js"
cp "$SRC/public/index.html" "$DIR/public/index.html"
if [ -f "$SRC/seed.json" ] && [ ! -f "$DIR/seed.json" ]; then cp "$SRC/seed.json" "$DIR/seed.json"; fi
umask 077
printf 'APP_PASSWORD=%s\nPORT=%s\nHOST=0.0.0.0\n' "$PASS" "$PORT" > "$DIR/.env"
chmod 600 "$DIR/.env"

# 4. Автозапуск. Память ограничена, чтобы сервис не мешал остальному на сервере.
cat > /etc/systemd/system/life.service <<EOF
[Unit]
Description=Zhizn v poryadke (personal life system)
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
EnvironmentFile=$DIR/.env
ExecStart=$NODE_BIN $DIR/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
MemoryMax=150M

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable life >/dev/null 2>&1
systemctl restart life

# 5. Файрвол (если включён)
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "${PORT}/tcp" >/dev/null && echo "Порт ${PORT} открыт в ufw."
fi

# 6. Проверка
sleep 2
if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/"; then
  IP="$(curl -fsS -4 --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
  echo ""
  echo "Готово. Открывай: http://${IP}:${PORT}"
  echo "Логи: journalctl -u life -f"
else
  echo "Сервис не ответил. Последние строки лога:"; journalctl -u life -n 20 --no-pager; exit 1
fi
