#!/usr/bin/env bash
# Загружает личные данные (зашифрованные) и включает автообновление с GitHub.
# Запуск: curl -fsSL https://raw.githubusercontent.com/Maks1122n/life-system/main/setup.sh | bash -s -- КЛЮЧ
set -euo pipefail
KEY="${1:-}"
DIR=/opt/life
RAW="https://raw.githubusercontent.com/Maks1122n/life-system/main"

[ -d "$DIR" ] || { echo "Сервис не установлен: сначала install.sh"; exit 1; }
[ -n "$KEY" ] || { echo "Нужен ключ: bash -s -- КЛЮЧ"; exit 1; }

count_goals() { node -e "try{const d=JSON.parse(require('fs').readFileSync('$DIR/data/data.json','utf8'));console.log(Object.keys(d.goals||{}).length)}catch(e){console.log(0)}"; }

# 1. Данные: загружаем, только если целей в сервисе ещё нет (твои правки не затираются)
if [ "$(count_goals)" = "0" ]; then
  T="$(mktemp)"
  curl -fsSL "$RAW/seed.enc?t=$(date +%s)" -o "$T.enc"
  if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$T.enc" -out "$T" -k "$KEY" 2>/dev/null; then
    echo "Ключ не подошёл. Проверь, что скопировал его целиком."; rm -f "$T" "$T.enc"; exit 1
  fi
  node -e "JSON.parse(require('fs').readFileSync('$T','utf8'))" || { echo "Данные повреждены."; exit 1; }
  cp "$T" "$DIR/seed.json"; rm -f "$T" "$T.enc"
  [ -f "$DIR/data/data.json" ] && mv "$DIR/data/data.json" "$DIR/data/before-import-$(date +%s).json"
  systemctl restart life
  sleep 2
fi

# 2. Автообновление: сервер раз в 5 минут сам забирает новую версию с GitHub
cat > "$DIR/update.sh" <<'EOF'
#!/usr/bin/env bash
set -u
RAW="https://raw.githubusercontent.com/Maks1122n/life-system/main"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
curl -fsSL "$RAW/server.js?t=$(date +%s)" -o "$T/server.js" || exit 0
curl -fsSL "$RAW/public/index.html?t=$(date +%s)" -o "$T/index.html" || exit 0
node --check "$T/server.js" || exit 0
grep -q "<title>" "$T/index.html" || exit 0
changed=0
cmp -s "$T/server.js" /opt/life/server.js || { cp "$T/server.js" /opt/life/server.js; changed=1; }
cmp -s "$T/index.html" /opt/life/public/index.html || cp "$T/index.html" /opt/life/public/index.html
[ "$changed" = 1 ] && systemctl restart life
exit 0
EOF
chmod +x "$DIR/update.sh"
cat > /etc/systemd/system/life-update.service <<EOF
[Unit]
Description=Update Zhizn v poryadke from GitHub
[Service]
Type=oneshot
ExecStart=$DIR/update.sh
EOF
cat > /etc/systemd/system/life-update.timer <<EOF
[Unit]
Description=Update Zhizn v poryadke every 5 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now life-update.timer >/dev/null 2>&1
"$DIR/update.sh"

# 3. Итог
node -e "const d=JSON.parse(require('fs').readFileSync('$DIR/data/data.json','utf8'));const n=k=>Object.keys(d[k]||{}).length;console.log('ГОТОВО. В сервисе: целей '+n('goals')+', задач '+n('tasks')+', сфер '+n('spheres')+'. Автообновление включено.')"
