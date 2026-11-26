#!/data/data/com.termux/files/usr/bin/bash
# CashPro — serveur D'ESSAI sur Android (Termux). Pour tester uniquement.
# Usage : bash ~/cashpro-android/start.sh          (ce téléphone seulement)
#         bash ~/cashpro-android/start.sh --wifi   (aussi les autres appareils du WiFi)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -z "$PREFIX" ] || [ ! -d "$PREFIX/bin" ]; then echo "À lancer dans Termux (Android)."; exit 1; fi
if ! command -v initdb >/dev/null || ! command -v node >/dev/null; then
  echo "[CashPro] Installation de PostgreSQL et Node.js (une seule fois)…"
  pkg update -y && pkg install -y postgresql nodejs-lts
fi
node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' || { echo "Node.js 18 ou plus récent requis : pkg install nodejs-lts"; exit 1; }
command -v termux-wake-lock >/dev/null && termux-wake-lock || true
export CASHPRO_PG_BIN="$PREFIX/bin"
if [ "$1" = "--wifi" ]; then
  export CASHPRO_DEMO_HOST=0.0.0.0
  IP=$(ip -4 addr show wlan0 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1)
  [ -n "$IP" ] && echo "[CashPro] Autres appareils du WiFi : http://$IP:4600"
fi
exec node "$DIR/demo.js"
