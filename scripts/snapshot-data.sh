#!/usr/bin/env bash
#
# **서버에서** 도는 스냅샷입니다. data/ 에서 되살릴 수 없는 것만 골라
# 앱 폴더 **밖**에 tar.gz 로 남깁니다.
#
#   scripts/snapshot-data.sh
#
# ── 왜 전부 담지 않는가 ─────────────────────────────────────────────────────
#
# data/ 는 7.4MB인데 그중 7.1MB(96%)가 **다시 받으면 되는 캐시**입니다.
# macro-vintages.json 6.3MB 하나가 대부분이고, backtest:fetch-macro 로 언제든
# 다시 만듭니다. 그것까지 매일 쌓으면 백업이 커져서 오래 보관하지 못하고,
# 정작 중요한 것을 오래 못 남기게 됩니다.
#
# 그래서 **되살릴 수 없는 것만** 담습니다. 압축하면 한 벌에 수십 KB라
# 하루 한 번씩 석 달을 쌓아도 몇 MB입니다.
#
# ── 왜 앱 폴더 밖인가 ───────────────────────────────────────────────────────
#
# 배포는 앱 폴더를 건드립니다. 백업이 그 안에 있으면 언젠가 배포 사고가
# 백업까지 같이 지웁니다. **같이 죽는 백업은 백업이 아닙니다.**

set -euo pipefail

APP_DIR="${TOSS_APP_DIR:-/home/ubuntu/toss-api/apps/toss-ai-agent}"
OUT_DIR="${TOSS_BACKUP_DIR:-/home/ubuntu/toss-backups}"
KEEP_DAYS="${TOSS_BACKUP_KEEP_DAYS:-90}"

# 되살릴 수 없는 것들. 캐시는 일부러 뺐습니다.
#   paper-events.jsonl           감성 판정 표본. 하루 ~23건씩 쌓이고 다시 못 만듭니다
#   paper-state.json             PAPER 장부
#   live-orders.jsonl            실주문 원장
#   live-position-baseline.json  대사 기준선
#   telegram-report-state.json   중복 전송 방지용. 작아서 같이 담습니다
PRECIOUS=(
  paper-events.jsonl
  paper-state.json
  live-orders.jsonl
  live-position-baseline.json
  telegram-report-state.json
)

die() { echo "snapshot-data: $*" >&2; exit 1; }

[ -d "$APP_DIR/data" ] || die "data 폴더가 없습니다: $APP_DIR/data"
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

stamp="$(date -u +%Y%m%d-%H%M%S)"
staging="$OUT_DIR/.staging-$stamp"
mkdir -p "$staging"
trap 'rm -rf "$staging"' EXIT

found=0
for f in "${PRECIOUS[@]}"; do
  if [ -s "$APP_DIR/data/$f" ]; then
    cp -p "$APP_DIR/data/$f" "$staging/$f"
    found=$((found + 1))
  fi
done

# 하나도 못 담았으면 만들지 않습니다. **빈 tar 가 쌓이면 백업이 있다고
# 착각하게 되고, 그 착각은 정작 필요한 순간에 드러납니다.**
[ "$found" -gt 0 ] || die "담을 파일이 하나도 없습니다. data/ 를 확인하세요."

# 무엇을 어떤 상태에서 담았는지 함께 남깁니다. 나중에 이 tar 하나만 보고도
# 판단할 수 있어야 합니다.
{
  echo "{"
  echo "  \"at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"host\": \"$(hostname)\","
  echo "  \"files\": $found,"
  printf '  "paperCycles": %s,\n' "$(wc -l < "$staging/paper-events.jsonl" 2>/dev/null | tr -d ' ' || echo 0)"
  printf '  "orderEvents": %s\n' "$(wc -l < "$staging/live-orders.jsonl" 2>/dev/null | tr -d ' ' || echo 0)"
  echo "}"
} > "$staging/MANIFEST.json"

archive="$OUT_DIR/toss-data-$stamp.tar.gz"
tar -czf "$archive" -C "$staging" .
chmod 600 "$archive"

# `$found개` 로 쓰면 안 됩니다 — bash 3.2 는 뒤에 붙은 한글까지 변수명으로 읽어
# `found개: unbound variable` 로 죽습니다. 변수 뒤에 한글이 붙으면 중괄호로 감쌉니다.
echo "snapshot-data: $archive ($(du -h "$archive" | cut -f1), 파일 ${found}개)"

# 오래된 것 정리. 삭제는 우리가 만든 이름 형태에만 적용합니다 — 폴더 안의
# 다른 무엇도 건드리지 않게 하기 위해서입니다.
find "$OUT_DIR" -maxdepth 1 -name 'toss-data-*.tar.gz' -type f \
  -mtime "+$KEEP_DAYS" -delete 2>/dev/null || true

total=$(find "$OUT_DIR" -maxdepth 1 -name 'toss-data-*.tar.gz' -type f | wc -l | tr -d ' ')
echo "snapshot-data: 보관 중 $total 벌 (최근 ${KEEP_DAYS}일)"
