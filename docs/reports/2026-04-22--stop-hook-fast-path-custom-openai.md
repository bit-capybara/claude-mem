# 2026-04-22 — Stop hook fast-path + custom_openai 검증 기록

## 목적
`running stop hook · 1m 3s` 지연을 줄이기 위해 Stop hook 대기 시간을 단축하고, `custom_openai` 경로(OmniRoute 모델) 동작을 빠르게 검증했다.

## 변경 요약

### 1) Stop hook 대기 fast-path 적용
- 파일: `src/cli/handlers/summarize.ts`
- 핵심 변경:
  - `MAX_WAIT_FOR_SUMMARY_MS`: `110_000` → `25_000`
  - 요약 완료가 25초 내 끝나지 않으면 Stop hook을 더 이상 붙잡지 않고 반환
  - 이 경우 session complete는 Stop에서 수행하지 않고 SessionEnd 경로로 이관되도록 defer 로그 추가

### 2) custom_openai provider 경로 반영 (이전 작업 포함)
- `custom_openai` provider를 worker/provider selection/settings/UI에 연결
- OmniRoute OpenAI-compatible endpoint를 통해 `opencode-go/qwen3.5-plus` 호출 가능 상태 확인

## 검증

### 빌드/배포
- `npm run build` 성공
- `npm run sync-marketplace` 성공
- 설치본 반영 확인:
  - `~/.claude/plugins/marketplaces/thedotmack/src/cli/handlers/summarize.ts`에 `MAX_WAIT_FOR_SUMMARY_MS = 25_000` 존재
  - 컴파일 산출물(`plugin/scripts/worker-service.cjs`)에도 반영 문자열 존재

### 런타임 상태
- worker 상태: running (`Port: 37701`)

## 기대 효과
- Stop hook 사용자 체감 대기시간을 최대 약 25초 수준으로 제한
- 기존 1분+ 블로킹 종료 경험 완화

## 주의 사항
- 요약 처리 자체가 느린 경우, Stop 훅 종료 후 비동기로 후속 처리될 수 있음
- Session completion 시점이 Stop/SessionEnd 사이에서 나뉠 수 있어 로그 타이밍이 달라질 수 있음

## 변경 파일
- `src/cli/handlers/summarize.ts`
- `docs/reports/2026-04-22--stop-hook-fast-path-custom-openai.md`

## 빠른 체크리스트
- [x] build 성공
- [x] marketplace sync 성공
- [x] worker running 확인
- [x] 설치본 코드 반영 확인
- [ ] 실사용 1~2세션에서 stop hook 체감 시간 재확인
