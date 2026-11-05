#!/usr/bin/env bash
# Подключение Telegram-бота к «Жизнь в порядке».
# Запуск на сервере: bash <(curl -fsSL https://raw.githubusercontent.com/Maks1122n/life-system/main/bot-setup.sh)
# Токен и ключ вводятся скрыто и хранятся только в /opt/life/.env (доступ только у root).
set -euo pipefail
ENV=/opt/life/.env
[ -f "$ENV" ] || { echo "Сервис не установлен: сначала install.sh"; exit 1; }

echo "Подключение Telegram-бота. Ввод не отображается на экране — это нормально."
read -rsp "1) Вставь токен бота от @BotFather и нажми Enter: " TG; echo
TG="$(echo -n "$TG" | tr -d '[:space:]')"
[[ "$TG" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]] || { echo "Это не похоже на токен бота. Скопируй его из @BotFather целиком."; exit 1; }
BOTNAME="$(curl -fsS "https://api.telegram.org/bot$TG/getMe" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.ok?j.result.username:"")}catch(e){console.log("")}})')" || BOTNAME=""
[ -n "$BOTNAME" ] || { echo "Telegram не принял токен. Проверь его в @BotFather."; exit 1; }
echo "   Бот найден: @$BOTNAME"

read -rsp "2) Вставь ключ OpenAI (начинается с sk-) и нажми Enter: " OK; echo
OK="$(echo -n "$OK" | tr -d '[:space:]')"
[[ "$OK" == sk-* ]] || { echo "Ключ OpenAI должен начинаться с sk-"; exit 1; }
CODE="$(curl -s -o /dev/null -w '%{http_code}' https://api.openai.com/v1/models -H "Authorization: Bearer $OK")"
[ "$CODE" = "200" ] || { echo "OpenAI не принял ключ (ответ $CODE). Проверь ключ и баланс."; exit 1; }
echo "   Ключ OpenAI работает"

PAIR="$(node -e 'console.log(require("crypto").randomBytes(3).toString("hex").toUpperCase())')"
TMP="$(mktemp)"
grep -v -E '^(TELEGRAM_BOT_TOKEN|OPENAI_API_KEY|TG_PAIR_CODE|APP_TZ)=' "$ENV" > "$TMP" || true
printf 'TELEGRAM_BOT_TOKEN=%s\nOPENAI_API_KEY=%s\nTG_PAIR_CODE=%s\nAPP_TZ=Europe/Moscow\n' "$TG" "$OK" "$PAIR" >> "$TMP"
install -m 600 "$TMP" "$ENV"; rm -f "$TMP"
rm -f /opt/life/data/bot.json

[ -x /opt/life/update.sh ] && /opt/life/update.sh || true
systemctl restart life
sleep 3
if journalctl -u life -n 20 --no-pager | grep -q "Telegram-бот включён"; then
  echo ""
  echo "ГОТОВО. Открой в Telegram @$BOTNAME и отправь одно сообщение:"
  echo ""
  echo "   /start $PAIR"
  echo ""
else
  echo "Бот не запустился. Последние строки лога:"; journalctl -u life -n 20 --no-pager; exit 1
fi
