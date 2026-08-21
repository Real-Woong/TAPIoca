# ver2 배포 — 리서치 인스턴스

> **이 브랜치는 실제 돈을 만지지 않는다.** 실전 배포 절차는 `main`의
> `deploy/DEPLOY.md`에 있고, 이 문서는 그것을 대신하지 않는다.

## 어디에 두는가

```
~/toss-api/apps/toss-ai-agent   ← main (실전)
~/toss-api/apps/TAPIOCA_ver2    ← ver2 (리서치)
```

## 가져오기

```bash
cd ~/toss-api/apps
git clone -b ver2 https://github.com/Real-Woong/TAPIoca.git TAPIOCA_ver2
cd TAPIOCA_ver2 && npm test
```

**`git worktree`가 아니라 별도 clone을 쓴다.** `data/`가 완전히 분리돼야
두 인스턴스가 서로의 장부를 건드리지 못한다.

## `.env` — 복사하되 주문 키는 비운다

```bash
grep -v '^LIVE_TRADING=' ../toss-ai-agent/.env > .env
chmod 600 .env
grep -c LIVE_TRADING .env    # 0 이어야 한다
```

`LIVE_TRADING`을 지워도 **코드가 한 번 더 막는다**(`src/paper/live-allowed.js`).
`LIVE_TRADING_ALLOWED = false`이므로 `true`로 켜면 실행이 던지고 멈춘다.
설정에 맡기지 않는 이유는 그 파일에 있다.

## 타이머 (필요할 때만)

```bash
sudo cp deploy/tapioca-ver2-*.service deploy/tapioca-ver2-*.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now tapioca-ver2-paper.timer
```

> ⚠️ **`deploy/*.service`처럼 와일드카드로 복사하지 않는다.** main의
> `DEPLOY.md`가 그렇게 하는데, 유닛 이름이 겹치면 **main의 실전 타이머가
> 교체된다.** 그래서 이 브랜치의 유닛은 이름을 바꿨고 main과 겹치는 유닛
> (`toss-ai-report`, `toss-ai-backup`)은 아예 지웠다. **보고서와 백업은
> main 인스턴스가 담당한다.**

확인:

```bash
systemctl list-timers 'tapioca-ver2-*'
systemctl list-timers 'toss-ai-*'      # main이 그대로인가
```

## 절대 하지 않는 것

| | 왜 |
|---|---|
| `LIVE_TRADING=true` | 같은 계좌에 봇 둘이 주문하면 보유 기준선이 어긋나 **main이 영구 정지한다** |
| main의 `data/`를 여기로 복사 | 실주문 원장과 기준선이 섞인다 |
| main과 같은 이름의 유닛 설치 | 실전 타이머가 교체된다 |
| 15분 주기 | 토스 API 한도는 계정 단위다 |
