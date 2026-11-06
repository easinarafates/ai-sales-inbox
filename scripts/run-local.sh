#!/usr/bin/env bash
# AI Sales Inbox — লোকাল চালু করার স্ক্রিপ্ট (Docker লাগবে না)।
# ব্যবহার: ./scripts/run-local.sh
#   API চলবে http://localhost:4000, ওয়েব চলবে http://localhost:3000
#   বন্ধ করতে: Ctrl+C চাপুন।
# ডেটাবেজ: PGlite (apps/.pglite-data ফোল্ডারে থাকে)। মুছে ফেললে ডেটা রিসেট হবে।
set -e
cd "$(dirname "$0")/.."

if [ ! -d apps/api/node_modules ]; then
  echo "API-র প্যাকেজ ইনস্টল হচ্ছে..."
  (cd apps/api && npm install)
fi
if [ ! -d apps/web/node_modules ]; then
  echo "ওয়েবের প্যাকেজ ইনস্টল হচ্ছে..."
  (cd apps/web && npm install)
fi

echo "API বিল্ড হচ্ছে..."
(cd apps/api && npm run build)
echo "ওয়েব বিল্ড হচ্ছে..."
(cd apps/web && npm run build)

cleanup() {
  echo "বন্ধ হচ্ছে..."
  kill "$API_PID" "$WEB_PID" ${WORKER_PID:-} 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "API চালু হচ্ছে (http://localhost:4000)..."
(cd apps/api && DATABASE_URL=pglite://../.pglite-data npm start) &
API_PID=$!

# Worker (ঐচ্ছিক): real Postgres + Redis থাকলে, এবং API সত্যিকারের ডেটাবেজে
# চললে, এভাবে চালান: START_WORKER=true ./scripts/run-local.sh
# PGlite মোডে worker চালানো যায় না (একই ডেটা ফোল্ডার দুই প্রসেস খুলতে
# পারে না) — সেখানে API নিজেই ৬০ সেকেন্ডে একবার due পোস্ট/ফলো-আপ চালায়।
if [ "${START_WORKER:-}" = "true" ]; then
  if [ ! -d workers/queue/node_modules ]; then
    echo "Worker-এর প্যাকেজ ইনস্টল হচ্ছে..."
    (cd workers/queue && npm install)
  fi
  echo "Worker বিল্ড হচ্ছে..."
  (cd workers/queue && npm run build)
  echo "Worker চালু হচ্ছে..."
  (cd workers/queue && set -a; [ -f ../../apps/api/.env ] && . ../../apps/api/.env; set +a; npm start) &
  WORKER_PID=$!
fi

echo "ওয়েব চালু হচ্ছে (http://localhost:3000)..."
(cd apps/web && npm start) &
WEB_PID=$!

echo ""
echo "চালু হয়েছে:"
echo "  API : http://localhost:4000/api/health"
echo "  ওয়েব: http://localhost:3000/login"
echo "বন্ধ করতে Ctrl+C চাপুন।"
wait
