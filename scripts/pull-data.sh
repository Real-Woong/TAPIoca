#!/usr/bin/env bash
#
# 서버의 data/ 를 로컬로 당겨 **시간별 스냅샷**으로 쌓습니다.
#
#   pull-data              한 벌 당긴다
#   pull-data --list       쌓인 스냅샷을 본다
#   pull-data --dry-run    무엇이 올지만 본다
#
# ── 설계에서 정한 것 ────────────────────────────────────────────────────────
#
# **한 방향입니다.** 서버 → 로컬로만 갑니다. 반대 방향은 이 스크립트에 없습니다.
# 로컬 사본을 서버로 밀면 그 순간 실주문 원장과 보유 기준선이 옛 상태로 덮이고,
# 그것은 되돌릴 수 없습니다.
#
# **덮어쓰지 않고 쌓습니다.** 미러링(한 벌만 유지)은 서버 파일이 망가졌을 때
# 멀쩡한 사본까지 같이 망가뜨립니다. 백업이 지켜야 하는 것이 바로 그 경우이므로
# 매번 새 폴더에 받고 옛것을 남깁니다. 파일이 작아서(수백 KB) 비용이 없습니다.
#
# 서버 주소는 코드에 넣지 않고 TOSS_SERVER 환경변수로 받습니다. 저장소가 공개라
# 접속 정보를 커밋할 수 없습니다.

set -euo pipefail

REMOTE_DIR="${TOSS_SERVER_DIR:-/home/ubuntu/toss-api/apps/toss-ai-agent}"
KEEP="${TOSS_BACKUP_KEEP:-30}"

# 저장소 어디서 실행하든 루트를 찾습니다.
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
DEST_ROOT="$ROOT/backups/data"

# 원장이 반드시 있어야 하는 파일들. 없으면 받은 것이 쓸모없습니다.
REQUIRED=(live-orders.jsonl live-position-baseline.json paper-state.json)

die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
ok()  { printf '\033[32m%s\033[0m\n' "$*"; }

case "${1:-}" in
  --list|-l)
    [ -d "$DEST_ROOT" ] || die "아직 백업이 없습니다. 먼저 pull-data 를 실행하세요."
    printf '%s\n\n' "$DEST_ROOT"
    for d in "$DEST_ROOT"/*/; do
      [ -d "$d" ] || continue
      printf '  %-20s %8s  %s\n' \
        "$(basename "$d")" \
        "$(du -sh "$d" | cut -f1)" \
        "$(ls "$d" | wc -l | tr -d ' ') files"
    done
    exit 0
    ;;
esac

[ -n "${TOSS_SERVER:-}" ] || die \
"TOSS_SERVER 가 설정돼 있지 않습니다.

  ~/.zshrc 에 접속 정보를 넣으십시오 (저장소에는 넣지 않습니다):

    export TOSS_SERVER=ubuntu@<서버주소>
"

command -v rsync >/dev/null || die "rsync 가 필요합니다."

STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$DEST_ROOT/$STAMP"

DRY=()
if [ "${1:-}" = "--dry-run" ] || [ "${1:-}" = "-n" ]; then
  DRY=(--dry-run)
  echo "[모의 실행 — 아무것도 저장하지 않습니다]"
fi

mkdir -p "$DEST"

# -a 권한·시각 보존, -z 압축. --delete 는 쓰지 않습니다. 매번 빈 폴더로
# 받으므로 지울 것이 애초에 없고, 습관으로 남으면 언젠가 사고가 납니다.
rsync -az ${DRY[@]+"${DRY[@]}"} --info=stats1 \
  "$TOSS_SERVER:$REMOTE_DIR/data/" "$DEST/" \
  || die "받기 실패. 서버 주소와 SSH 접속을 확인하세요: $TOSS_SERVER"

if [ ${#DRY[@]} -gt 0 ]; then
  rmdir "$DEST" 2>/dev/null || true
  exit 0
fi

# 받은 것이 쓸 만한지 확인합니다. 빈 폴더를 백업이라고 부르면 안 됩니다.
missing=()
for f in "${REQUIRED[@]}"; do
  [ -s "$DEST/$f" ] || missing+=("$f")
done
if [ ${#missing[@]} -gt 0 ]; then
  printf '\033[33m경고: 다음 파일이 없거나 비어 있습니다 — %s\033[0m\n' "${missing[*]}"
  echo "      서버에서 아직 만들어지지 않았을 수 있습니다. 스냅샷은 남겨 둡니다."
fi

ln -sfn "$DEST" "$DEST_ROOT/latest"

ok "✓ $STAMP 로 받았습니다"
printf '  %s\n' "$DEST"
[ -s "$DEST/live-orders.jsonl" ] &&
  printf '  실주문 원장: %s 건\n' "$(wc -l < "$DEST/live-orders.jsonl" | tr -d ' ')"
[ -s "$DEST/paper-events.jsonl" ] &&
  printf '  PAPER 사이클: %s 건\n' "$(wc -l < "$DEST/paper-events.jsonl" | tr -d ' ')"

# 오래된 스냅샷 정리. 최신 KEEP개만 남깁니다.
# mapfile 은 bash 4+ 라 macOS 기본 bash(3.2)에서 안 돕니다. 이름이 타임스탬프라
# 사전순 = 시간순이므로 정렬 후 앞에서부터 지웁니다.
total=$(find "$DEST_ROOT" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
if [ "$total" -gt "$KEEP" ]; then
  drop=$(( total - KEEP ))
  find "$DEST_ROOT" -mindepth 1 -maxdepth 1 -type d | sort | head -n "$drop" |
    while IFS= read -r d; do rm -rf "$d"; done
  echo "  오래된 스냅샷 ${drop}개 정리 (최근 ${KEEP}개 유지)"
fi
