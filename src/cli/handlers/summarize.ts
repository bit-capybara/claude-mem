/**
 * Summarize Handler - Stop
 *
 * Runs in the Stop hook (120s timeout, not capped like SessionEnd).
 * This is the ONLY place where we can reliably wait for async work.
 *
 * Flow:
 * 1. Queue summarize request to worker
 * 2. Poll worker until summary processing completes
 * 3. Call /api/sessions/complete to clean up session
 *
 * SessionEnd (1.5s cap from Claude Code) is just a lightweight fallback —
 * all real work must happen here in Stop.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, workerHttpRequest } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { extractLastMessage } from '../../shared/transcript-parser.js';
import { HOOK_EXIT_CODES, HOOK_TIMEOUTS, getTimeout } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';

const SUMMARIZE_TIMEOUT_MS = getTimeout(HOOK_TIMEOUTS.DEFAULT);
const POLL_INTERVAL_MS = 500;
const MAX_WAIT_FOR_SUMMARY_MS = 25_000; // fast-path: stop hook waits briefly, worker continues async processing

export const summarizeHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    if (input.agentId) {
      logger.debug('HOOK', 'Skipping summary: subagent context detected', {
        sessionId: input.sessionId,
        agentId: input.agentId,
        agentType: input.agentType
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const { sessionId, transcriptPath } = input;

    if (!transcriptPath) {
      logger.debug('HOOK', `No transcriptPath in Stop hook input for session ${sessionId} - skipping summary`);
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    let lastAssistantMessage = '';
    try {
      lastAssistantMessage = extractLastMessage(transcriptPath, 'assistant', true);
    } catch (err) {
      logger.warn('HOOK', `Stop hook: failed to extract last assistant message for session ${sessionId}: ${err instanceof Error ? err.message : err}`);
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (!lastAssistantMessage || !lastAssistantMessage.trim()) {
      logger.debug('HOOK', 'No assistant message in transcript - skipping summary', {
        sessionId,
        transcriptPath
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    logger.dataIn('HOOK', 'Stop: Requesting summary', {
      hasLastAssistantMessage: !!lastAssistantMessage
    });

    const platformSource = normalizePlatformSource(input.platform);

    let response: Response;
    try {
      response = await workerHttpRequest('/api/sessions/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentSessionId: sessionId,
          last_assistant_message: lastAssistantMessage,
          platformSource
        }),
        timeoutMs: SUMMARIZE_TIMEOUT_MS
      });
    } catch (err) {
      logger.warn('HOOK', `Stop hook: summarize request failed: ${err instanceof Error ? err.message : err}`);
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (!response.ok) {
      return { continue: true, suppressOutput: true };
    }

    logger.debug('HOOK', 'Summary request queued, waiting for completion');

    const waitStart = Date.now();
    let summaryStored: boolean | null = null;
    let completed = false;

    while ((Date.now() - waitStart) < MAX_WAIT_FOR_SUMMARY_MS) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

      let statusResponse: Response;
      let status: { queueLength?: number; summaryStored?: boolean | null };
      try {
        statusResponse = await workerHttpRequest(`/api/sessions/status?contentSessionId=${encodeURIComponent(sessionId)}`, { timeoutMs: 5000 });
        status = await statusResponse.json() as { queueLength?: number; summaryStored?: boolean | null };
      } catch (pollError) {
        logger.debug('HOOK', 'Summary status poll failed, retrying', { error: pollError instanceof Error ? pollError.message : String(pollError) });
        continue;
      }

      const queueLength = status.queueLength ?? 0;
      if (queueLength === 0 && statusResponse.status !== 404) {
        completed = true;
        summaryStored = status.summaryStored ?? null;
        logger.info('HOOK', 'Summary processing complete', {
          waitedMs: Date.now() - waitStart,
          summaryStored
        });
        if (summaryStored === false) {
          logger.warn('HOOK', 'Summary was not stored: LLM response likely lacked valid <summary> tags (#1633)', {
            sessionId,
            waitedMs: Date.now() - waitStart
          });
        }
        break;
      }
    }

    if (!completed) {
      logger.info('HOOK', 'Summary wait budget exceeded, continuing without blocking Stop hook', {
        waitedMs: Date.now() - waitStart,
        maxWaitMs: MAX_WAIT_FOR_SUMMARY_MS,
        sessionId
      });
      logger.info('HOOK', 'Session completion deferred to SessionEnd hook', { contentSessionId: sessionId });
      return { continue: true, suppressOutput: true };
    }

    try {
      await workerHttpRequest('/api/sessions/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentSessionId: sessionId }),
        timeoutMs: 10_000
      });
      logger.info('HOOK', 'Session completed in Stop hook', { contentSessionId: sessionId });
    } catch (err) {
      logger.warn('HOOK', `Stop hook: session-complete failed: ${err instanceof Error ? err.message : err}`);
    }

    return { continue: true, suppressOutput: true };
  }
};
