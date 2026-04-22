# claude-mem 포크 변경사항

> 원본: [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)  
> 이 포크: [bit-capybara/claude-mem](https://github.com/bit-capybara/claude-mem)

이 문서는 원본 저장소 대비 **이 포크에서 추가/변경된 기능만** 정리한다.

---

## 1. Custom OpenAI Provider 추가

**커밋**: `4e8a666`

Omniroute 등 OpenAI-compatible API 프록시를 claude-mem provider로 사용할 수 있게 했다.

### 설정 (`~/.claude-mem/settings.json`)

```json
{
  "CLAUDE_MEM_PROVIDER": "custom_openai",
  "CLAUDE_MEM_CUSTOM_OPENAI_BASE_URL": "http://127.0.0.1:20128/v1",
  "CLAUDE_MEM_CUSTOM_OPENAI_API_KEY": "sk-xxxxx",
  "CLAUDE_MEM_CUSTOM_OPENAI_MODEL": "opencode-go/qwen3.5-plus",
  "CLAUDE_MEM_CUSTOM_OPENAI_PATH": "/chat/completions",
  "CLAUDE_MEM_CUSTOM_OPENAI_TIMEOUT_MS": "120000",
  "CLAUDE_MEM_CUSTOM_OPENAI_MAX_CONTEXT_MESSAGES": "20",
  "CLAUDE_MEM_CUSTOM_OPENAI_MAX_TOKENS": "100000"
}
```

### 변경 파일
- `src/services/worker/CustomOpenAIAgent.ts` (신규)
- `src/services/worker-types.ts`
- `src/services/worker-service.ts`
- `src/services/worker/http/routes/SettingsRoutes.ts`
- `src/shared/SettingsDefaultsManager.ts`
- `src/ui/viewer/components/ContextSettingsModal.tsx`
- `src/ui/viewer/constants/settings.ts`
- `src/ui/viewer/types.ts`

---

## 2. Stop Hook Fast-path + 대기 시간 축소

**커밋**: `4e8a666`

Stop hook에서 summary 생성이 완료될 때까지 세션 종료를 무제한 대기하던 문제를 해결했다.

- 요약 대기 최대 시간: **25초** (기존에는 1분 이상 blocking)
- 25초 초과 시 `SessionEnd` hook으로 summary 생성을 **deferred** 처리
- 세션 종료가 summary 완료에 막히지 않음

### 변경 파일
- `src/cli/handlers/summarize.ts`
- `src/services/worker/session/SessionCompletionHandler.ts`
- `src/services/worker/http/routes/SessionRoutes.ts`

---

## 3. SSE/Non-JSON 응답 대응

**커밋**: `1fd1648`

Omniroute 등 일부 프록시가 `stream: true`를 기본으로 사용하거나, 응답에 SSE 마커(`data: [DONE]`, `: x-omniroute-...`)가 포함되어 `JSON.parse()`가 실패하던 문제를 해결했다.

### 증상 (패치 전)
```
[ERROR] OpenRouter init failed {model=opencode-go/qwen3.5-plus} Failed to parse JSON
[INFO] Pending work remains after generator exit, restarting with fresh AbortController
[ERROR] Unhandled rejection in daemon {reason=Failed to parse JSON}
```
→ attempt 114→117 무한 재시작, 70개 메시지 orphaned

### 해결책
1. **요청 시 `stream: false` 명시** — `CustomOpenAIAgent.ts`, `OpenRouterAgent.ts`
2. **JSON 파싱 강화** — `response.json()` → `response.text()` + `JSON.parse()` try-catch
3. **unrecoverable error 분류** — `"non-JSON response"`, `"Unexpected token"`, `"Failed to parse JSON"`를 재시작 금지 패턴에 추가

### 변경 파일
- `src/services/worker/CustomOpenAIAgent.ts`
- `src/services/worker/OpenRouterAgent.ts`
- `src/services/worker-service.ts`

---

## 설치 및 적용

```bash
# 1. 포크 클론
git clone https://github.com/bit-capybara/claude-mem.git

# 2. 빌드
cd claude-mem
npm install
npm run build

# 3. Claude Code 플러그인 경로로 동기화
npm run sync-marketplace
```

---

## 원본 저장소와의 동기화

```bash
# upstream 추가 (최초 1회)
git remote add upstream https://github.com/thedotmack/claude-mem.git

# upstream 최신 변경 가져오기
git fetch upstream main

# upstream 변경을 현재 포크에 머지
git merge upstream/main
```

---

## 알려진 이슈

- **Omniroute 프록시 미호환**: `stream: false`를 명시필도 `text/event-stream`으로 응답하는 프록시의 경우, `response.text()` 이후 `
data: [DONE]\n` 같은 SSE 트레일러가 JSON 뒤에 붙어 파싱이 실패할 수 있다. 이 경우 프록시 설정에서 SSE/스트리밍을 비활성화해야 한다.
- **macOS 바이너리**: `plugin/scripts/claude-mem`은 macOS arm64 전용. Linux에서는 JS fallback (`bun-runner.js` → `worker-service.cjs`)이 자동으로 사용된다.
