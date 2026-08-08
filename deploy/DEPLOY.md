# 서버 배포

> 저장소에는 문서와 기록이 함께 있지만, **서버에는 실행에 필요한 것만 보냅니다.**
> 서버가 하는 일은 두 가지뿐입니다.
>
> ```
> src/paper/paper-runner.js      15분 주기 PAPER 사이클
> src/telegram/daily-report.js   일일 보고서
> ```

## 서버에 있어야 하는 것

| 대상 | 왜 |
|---|---|
| `src/` | 실행 코드 전부 |
| `package.json` | `npm run` 스크립트 정의 |
| `scripts/` | `npm test` 러너 (배포 전 검사용) |
| `test/` | 배포 전 검사용. 안 돌릴 거면 빼도 됩니다 |
| `deploy/` | systemd 유닛 원본 |

## 서버에만 있고 **절대 덮어쓰면 안 되는 것**

```text
.env      비밀값. 저장소에 없고, 있어서도 안 됩니다
data/     PAPER 장부·실주문 원장·보유 기준선. 덮어쓰면 매매 이력이 사라집니다
```

> **`data/`를 날리면 복구가 안 됩니다.** `live-orders.jsonl`은 실주문 원장이고
> `live-position-baseline.json`은 "우리가 손대기 전 계좌"입니다. 기준선을 잃으면
> 대사가 깨져 실행기가 영구 정지합니다.

## 보내기

`REMOTE`를 자기 접속 정보로 바꿉니다.

```bash
REMOTE=ubuntu@<서버주소>
DEST=/home/ubuntu/toss-api/apps/toss-ai-agent

rsync -avz \
  --exclude='.git/' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='data/' \
  --exclude='node_modules/' \
  --exclude='.DS_Store' \
  src/ package.json scripts/ test/ deploy/ \
  "$REMOTE:$DEST/"
```

**`--delete`를 기본으로 쓰지 않습니다.** 편해 보이지만 한 번의 오타로 `data/`나
`.env`를 지웁니다. 서버에 남은 옛 파일을 정리해야 할 때만, 지울 목록을 먼저 눈으로
확인하고 씁니다.

```bash
# 1) 무엇이 지워질지 먼저 본다 (-n = 실제로는 아무것도 안 함)
rsync -avzn --delete --exclude='.env' --exclude='.env.*' --exclude='data/' \
  --exclude='node_modules/' --exclude='.git/' \
  src/ package.json scripts/ test/ deploy/ "$REMOTE:$DEST/"

# 2) 목록이 납득되면 -n 을 뺀다
```

### git으로 받고 싶다면

서버에서 `git pull`을 쓰면 문서까지 따라옵니다. 무해하지만 필요 없다면 sparse
checkout으로 코드만 받을 수 있습니다.

```bash
git clone --filter=blob:none --no-checkout https://github.com/Real-Woong/TAPIoca.git "$DEST"
cd "$DEST"
git sparse-checkout set src scripts test deploy package.json
git checkout main
```

> **주의:** 2026-08-08에 히스토리를 재작성했습니다. 서버에 이전 클론이 있다면
> `git pull`이 옛 커밋을 되살려 merge합니다. 반드시 아래로 맞추십시오.
>
> ```bash
> git fetch origin && git reset --hard origin/main
> ```

## 처음 한 번만

```bash
# .env 를 서버에서 직접 만든다 (로컬에서 복사해 보내지 않습니다)
ssh "$REMOTE" "nano $DEST/.env && chmod 600 $DEST/.env"

# systemd 유닛 설치
ssh "$REMOTE" "sudo cp $DEST/deploy/*.service $DEST/deploy/*.timer /etc/systemd/system/ \
  && sudo systemctl daemon-reload \
  && sudo systemctl enable --now toss-ai-paper.timer toss-ai-report.timer"
```

서버의 공인 IP가 토스 WTS `Open API > 허용 IP 관리`에 등록돼 있어야 합니다.

## 배포 후 확인

```bash
ssh "$REMOTE" "cd $DEST && npm test"                    # 구조가 그대로인가
ssh "$REMOTE" "cd $DEST && npm run doctor"              # 토큰·계좌가 보이는가
ssh "$REMOTE" "systemctl list-timers 'toss-ai-*'"       # 다음 실행이 잡혔는가
ssh "$REMOTE" "journalctl -u toss-ai-paper -n 50 --no-pager"
```

유닛은 노드를 직접 실행합니다. **소스만 바꿨다면 데몬 재시작이 필요 없습니다** —
다음 one-shot 실행이 새 파일을 읽습니다. `.service` 파일 자체를 바꿨을 때만
`daemon-reload`가 필요합니다.

## data/ 백업 — 반대 방향

`data/`는 **서버에만 있습니다.** git이 무시하므로 저장소가 지켜주지 않습니다.

### 무엇을 지켜야 하는가

`data/`는 7.4MB인데 **그중 96%가 다시 받으면 되는 캐시**입니다.

| 되살릴 수 없음 | 크기 | | 되살릴 수 있음 | 되살리는 법 |
|---|---:|---|---|---|
| `paper-events.jsonl` | 258KB | | `macro-vintages.json` (6.3MB) | `backtest:fetch-macro` |
| `paper-state.json` | 28KB | | `backtest-closes.json` | `backtest:fetch` |
| `live-orders.jsonl` | 3KB | | `free-news-cache` 등 캐시 | 다음 사이클이 생성 |
| `live-position-baseline.json` | 199B | | | |

지켜야 할 것은 **290KB**뿐이고, 압축하면 **약 20KB**입니다.

### 층 둘로 나눠 둡니다

```text
서버   매일 16:30 ET   되살릴 수 없는 것만 tar.gz → /home/ubuntu/toss-backups/
로컬   매주 토 11:00   그 tar.gz 들만 rsync → backups/snapshots/
```

서버 스냅샷은 **앱 폴더 밖**에 둡니다. 배포는 앱 폴더를 건드리므로, 백업이 그
안에 있으면 언젠가 배포 사고가 백업까지 지웁니다. **같이 죽는 백업은 백업이
아닙니다.**

설치:

```bash
ssh "$REMOTE" "sudo cp $DEST/deploy/toss-ai-backup.{service,timer} /etc/systemd/system/ \
  && sudo systemctl daemon-reload \
  && sudo systemctl enable --now toss-ai-backup.timer"

ssh "$REMOTE" "bash $DEST/scripts/snapshot-data.sh"     # 한 번 손으로 확인
```

로컬은 launchd가 토요일 11:00에 `pull-snapshots`를 부릅니다.

```bash
launchctl list | grep tapioca                            # 등록 확인
tail ~/Library/Logs/tapioca/pull-snapshots.log           # 지난 실행 결과
pull-snapshots                                           # 손으로 지금 받기
pull-snapshots --list                                    # 쌓인 것 보기
```

### 통째로 받기 (가끔, 손으로)

캐시까지 전부 필요할 때만 씁니다.

```bash
pull-data            # 서버 data/ 전체를 타임스탬프 폴더로
pull-data --list
pull-data -n         # 모의 실행
```

`~/.zshrc`에 접속 정보가 있어야 합니다(저장소에는 넣지 않습니다).

```bash
export TOSS_SERVER="ubuntu@<서버주소>"
```

### 반대 방향은 없습니다

로컬 사본을 서버로 밀면 그 순간 실주문 원장과 기준선이 옛 상태로 덮이고
되돌릴 수 없으므로, **그 명령을 아예 만들지 않았습니다.** 서버 `data/`를
되살려야 하는 상황이 오면 그때 사람이 판단해서 손으로 옮깁니다.

되살릴 때는 tar를 풀어 필요한 파일만 골라 넣습니다.

```bash
tar -xzf toss-data-20260808-203000.tar.gz -C /tmp/restore
cat /tmp/restore/MANIFEST.json      # 언제·무엇이 담겼는지 먼저 본다
```

## 급할 때

```bash
ssh "$REMOTE" "cd $DEST && npm run stop"     # 다음 사이클부터 주문 중지
ssh "$REMOTE" "sudo systemctl stop toss-ai-paper.timer"   # 사이클 자체를 멈춤
```

`npm run stop`은 `data/EMERGENCY_STOP` 파일을 만듭니다. 환경변수가 아니라 파일인
이유는 재시작 없이 다음 사이클부터 즉시 듣게 하기 위해서입니다.
