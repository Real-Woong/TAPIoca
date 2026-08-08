#!/usr/bin/env bash
#
# 서버가 매일 만든 **작은 스냅샷**만 받아옵니다. 토요일 launchd 가 부릅니다.
#
#   pull-snapshots         받기
#   pull-snapshots --list  로컬에 쌓인 것 보기
#
# `pull-data` 와 나눠 둔 이유가 있습니다.
#
#   pull-data       data/ 통째로 7.4MB. 손으로, 가끔. 캐시까지 그대로 뜬다
#   pull-snapshots  되살릴 수 없는 것만 담긴 tar.gz 몇십 KB. 자동으로, 매주
#
# 자동으로 도는 것은 작고 조용해야 합니다. 매주 7.4MB를 받으면 금세 GB가 되고,
# 그러면 오래 보관하지 못해 정작 필요할 때 옛것이 없습니다. rsync 라 이미 받은
# tar 는 다시 받지 않으므로 실제 전송량은 새로 생긴 며칠치뿐입니다.

set -euo pipefail

REMOTE_DIR="${TOSS_BACKUP_DIR:-/home/ubuntu/toss-backups}"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
DEST="$ROOT/backups/snapshots"

die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

if [ "${1:-}" = "--list" ] || [ "${1:-}" = "-l" ]; then
  [ -d "$DEST" ] || die "아직 받은 스냅샷이 없습니다."
  printf '%s\n\n' "$DEST"
  ls -1t "$DEST"/toss-data-*.tar.gz 2>/dev/null | while IFS= read -r f; do
    printf '  %-34s %8s\n' "$(basename "$f")" "$(du -h "$f" | cut -f1)"
  done
  printf '\n  총 %s 벌 · %s\n' \
    "$(ls -1 "$DEST"/toss-data-*.tar.gz 2>/dev/null | wc -l | tr -d ' ')" \
    "$(du -sh "$DEST" | cut -f1)"
  exit 0
fi

[ -n "${TOSS_SERVER:-}" ] || die "TOSS_SERVER 가 설정돼 있지 않습니다. ~/.zshrc 를 확인하세요."
case "$TOSS_SERVER" in
  *CHANGE-ME*) die "TOSS_SERVER 가 아직 예시값입니다: $TOSS_SERVER" ;;
esac

mkdir -p "$DEST"

err="$DEST/.rsync-err.$$"
trap 'rm -f "$err"' EXIT

# --delete 는 쓰지 않습니다. 서버는 90일 뒤 옛 tar 를 지우는데, 그 삭제가
# **로컬까지 전파되면 안 됩니다.** 서버보다 오래 보관하는 것이 백업의 요점입니다.
set +e
rsync -az --ignore-existing \
  "$TOSS_SERVER:$REMOTE_DIR/toss-data-*.tar.gz" "$DEST/" 2>"$err"
code=$?
set -e

if [ "$code" -ne 0 ]; then
  cat "$err" >&2
  die "받기 실패 (rsync 종료코드 $code): $TOSS_SERVER:$REMOTE_DIR"
fi

count=$(ls -1 "$DEST"/toss-data-*.tar.gz 2>/dev/null | wc -l | tr -d ' ')
newest=$(ls -1t "$DEST"/toss-data-*.tar.gz 2>/dev/null | head -1)

printf '\033[32m✓ 스냅샷 %s 벌 보관 중 (%s)\033[0m\n' "$count" "$(du -sh "$DEST" | cut -f1)"
[ -n "$newest" ] && printf '  최신: %s\n' "$(basename "$newest")"

# 최신 것이 너무 오래됐으면 알려 줍니다. **조용히 안 도는 백업이 가장 위험합니다** —
# 잃고 나서야 몇 주 전에 멈춰 있었다는 것을 알게 됩니다.
if [ -n "$newest" ]; then
  age_days=$(( ( $(date +%s) - $(stat -f %m "$newest" 2>/dev/null || stat -c %Y "$newest") ) / 86400 ))
  if [ "$age_days" -gt 3 ]; then
    printf '\033[33m  ⚠ 최신 스냅샷이 %s일 전입니다. 서버 타이머를 확인하세요:\033[0m\n' "$age_days"
    printf '      ssh %s "systemctl list-timers toss-ai-backup.timer"\n' "$TOSS_SERVER"
  fi
fi
