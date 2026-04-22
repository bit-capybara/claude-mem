/**
 * OpenRouterAgent: OpenRouter-based observation extraction
 *
 * Alternative to SDKAgent that uses OpenRouter's unified API
 * for accessing 100+ models from different providers.
 *
 * Responsibility:
 * - Call OpenRouter REST API for observation extraction
 * - Parse XML responses (same format as Claude/Gemini)
 * - Sync to database and Chroma
 * - Support dynamic model selection across providers
 */

import { buildContinuationPrompt, buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from '../../sdk/prompts.js';
import { getCredential } from '../../shared/EnvManager.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ModeConfig } from '../domain/types.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import {
  isAbortError,
  processAgentResponse,
  shouldFallbackToClaude,
  type FallbackAgent,
  type WorkerRef
} from './agents/index.js';

// OpenRouter API endpoint
const DEFAULT_CUSTOM_OPENAI_BASE_URL = 'http://127.0.0.1:20128/v1';
const DEFAULT_CUSTOM_OPENAI_PATH = '/chat/completions';

// Context window management constants (defaults, overridable via settings)
const DEFAULT_MAX_CONTEXT_MESSAGES = 20;  // Maximum messages to keep in conversation history
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;  // ~100k tokens max context (safety limit)
const CHARS_PER_TOKEN_ESTIMATE = 4;  // Conservative estimate: 1 token = 4 chars

// OpenAI-compatible message format
interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface CustomOpenAIResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    code?: string;
  };
}

export class CustomOpenAIAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Set the fallback agent (Claude SDK) for when OpenRouter API fails
   * Must be set after construction to avoid circular dependency
   */
  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  /**
   * Start OpenRouter agent for a session
   * Uses multi-turn conversation to maintain context across messages
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    // Get OpenRouter configuration (pure lookup, no external I/O)
    const { apiKey, model, baseUrl, path, timeoutMs } = this.getCustomOpenAIConfig();

    if (!apiKey) {
      throw new Error('Custom OpenAI API key not configured. Set CLAUDE_MEM_CUSTOM_OPENAI_API_KEY in settings or CUSTOM_OPENAI_API_KEY environment variable.');
    }

    // Generate synthetic memorySessionId (OpenRouter is stateless, doesn't return session IDs)
    if (!session.memorySessionId) {
      const syntheticMemorySessionId = `custom-openai-${session.contentSessionId}-${Date.now()}`;
      session.memorySessionId = syntheticMemorySessionId;
      this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
      logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=CustomOpenAI`);
    }

    // Load active mode
    const mode = ModeManager.getInstance().getActiveMode();

    // Build initial prompt
    const initPrompt = session.lastPromptNumber === 1
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
      : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

    // Send init prompt to OpenRouter
    session.conversationHistory.push({ role: 'user', content: initPrompt });

    try {
      const initResponse = await this.queryCustomOpenAIMultiTurn(session.conversationHistory, apiKey, model, baseUrl, path, timeoutMs);
      await this.handleInitResponse(initResponse, session, worker, model);
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error('SDK', 'OpenRouter init failed', { sessionId: session.sessionDbId, model }, error);
      } else {
        logger.error('SDK', 'OpenRouter init failed with non-Error', { sessionId: session.sessionDbId, model }, new Error(String(error)));
      }
      await this.handleSessionError(error, session, worker);
      return;
    }

    // Track lastCwd from messages for CLAUDE.md generation
    let lastCwd: string | undefined;

    // Process pending messages
    try {
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        lastCwd = await this.processOneMessage(session, message, lastCwd, apiKey, model, baseUrl, path, timeoutMs, worker, mode);
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error('SDK', 'OpenRouter message processing failed', { sessionId: session.sessionDbId, model }, error);
      } else {
        logger.error('SDK', 'OpenRouter message processing failed with non-Error', { sessionId: session.sessionDbId, model }, new Error(String(error)));
      }
      await this.handleSessionError(error, session, worker);
      return;
    }

    // Mark session complete
    const sessionDuration = Date.now() - session.startTime;
    logger.success('SDK', 'OpenRouter agent completed', {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      historyLength: session.conversationHistory.length,
      model
    });
  }

  /**
   * Prepare common message metadata before processing.
   * Tracks message IDs and captures subagent identity.
   */
  private prepareMessageMetadata(session: ActiveSession, message: { _persistentId: number; agentId?: string | null; agentType?: string | null }): void {
    // CLAIM-CONFIRM: Track message ID for confirmProcessed() after successful storage
    session.processingMessageIds.push(message._persistentId);

    // Capture subagent identity from the claimed message so ResponseProcessor
    // can label observation rows with the originating Claude Code subagent.
    // Always overwrite (even with null) so a main-session message after a subagent
    // message clears the stale identity; otherwise mixed batches could mislabel.
    session.pendingAgentId = message.agentId ?? null;
    session.pendingAgentType = message.agentType ?? null;
  }

  /**
   * Handle the init response from OpenRouter: update token counts and process or log empty.
   */
  private async handleInitResponse(
    initResponse: { content: string; tokensUsed?: number },
    session: ActiveSession,
    worker: WorkerRef | undefined,
    model: string
  ): Promise<void> {
    if (initResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: initResponse.content });
      const tokensUsed = initResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

      await processAgentResponse(
        initResponse.content, session, this.dbManager, this.sessionManager,
        worker, tokensUsed, null, 'CustomOpenAI', undefined, model
      );
    } else {
      logger.error('SDK', 'Empty OpenRouter init response - session may lack context', {
        sessionId: session.sessionDbId, model
      });
    }
  }

  /**
   * Process one message from the iterator: prepare metadata, dispatch to observation or summary handler.
   * Returns the updated lastCwd value.
   */
  private async processOneMessage(
    session: ActiveSession,
    message: { _persistentId: number; agentId?: string | null; agentType?: string | null; type?: string; cwd?: string; prompt_number?: number; tool_name?: string; tool_input?: unknown; tool_response?: unknown; last_assistant_message?: string },
    lastCwd: string | undefined,
    apiKey: string,
    model: string,
    baseUrl: string,
    endpointPath: string,
    timeoutMs: number,
    worker: WorkerRef | undefined,
    mode: ModeConfig
  ): Promise<string | undefined> {
    this.prepareMessageMetadata(session, message);

    if (message.cwd) {
      lastCwd = message.cwd;
    }
    const originalTimestamp = session.earliestPendingTimestamp;

    if (message.type === 'observation') {
      await this.processObservationMessage(
        session, message, originalTimestamp, lastCwd,
        apiKey, model, baseUrl, endpointPath, timeoutMs, worker, mode
      );
    } else if (message.type === 'summarize') {
      await this.processSummaryMessage(
        session, message, originalTimestamp, lastCwd,
        apiKey, model, baseUrl, endpointPath, timeoutMs, worker, mode
      );
    }

    return lastCwd;
  }

  /**
   * Process a single observation message: build prompt, call OpenRouter, store result.
   */
  private async processObservationMessage(
    session: ActiveSession,
    message: { prompt_number?: number; tool_name?: string; tool_input?: unknown; tool_response?: unknown; cwd?: string },
    originalTimestamp: number | null,
    lastCwd: string | undefined,
    apiKey: string,
    model: string,
    baseUrl: string,
    endpointPath: string,
    timeoutMs: number,
    worker: WorkerRef | undefined,
    _mode: ModeConfig
  ): Promise<void> {
    if (message.prompt_number !== undefined) {
      session.lastPromptNumber = message.prompt_number;
    }

    // CRITICAL: Check memorySessionId BEFORE making expensive LLM call
    if (!session.memorySessionId) {
      throw new Error('Cannot process observations: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    const obsPrompt = buildObservationPrompt({
      id: 0,
      tool_name: message.tool_name!,
      tool_input: JSON.stringify(message.tool_input),
      tool_output: JSON.stringify(message.tool_response),
      created_at_epoch: originalTimestamp ?? Date.now(),
      cwd: message.cwd
    });

    session.conversationHistory.push({ role: 'user', content: obsPrompt });
    const obsResponse = await this.queryCustomOpenAIMultiTurn(session.conversationHistory, apiKey, model, baseUrl, endpointPath, timeoutMs);

    let tokensUsed = 0;
    if (obsResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: obsResponse.content });
      tokensUsed = obsResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
    }

    await processAgentResponse(
      obsResponse.content || '', session, this.dbManager, this.sessionManager,
      worker, tokensUsed, originalTimestamp, 'CustomOpenAI', lastCwd, model
    );
  }

  /**
   * Process a single summary message: build prompt, call OpenRouter, store result.
   */
  private async processSummaryMessage(
    session: ActiveSession,
    message: { last_assistant_message?: string },
    originalTimestamp: number | null,
    lastCwd: string | undefined,
    apiKey: string,
    model: string,
    baseUrl: string,
    endpointPath: string,
    timeoutMs: number,
    worker: WorkerRef | undefined,
    mode: ModeConfig
  ): Promise<void> {
    // CRITICAL: Check memorySessionId BEFORE making expensive LLM call
    if (!session.memorySessionId) {
      throw new Error('Cannot process summary: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    const summaryPrompt = buildSummaryPrompt({
      id: session.sessionDbId,
      memory_session_id: session.memorySessionId,
      project: session.project,
      user_prompt: session.userPrompt,
      last_assistant_message: message.last_assistant_message || ''
    }, mode);

    session.conversationHistory.push({ role: 'user', content: summaryPrompt });
    const summaryResponse = await this.queryCustomOpenAIMultiTurn(session.conversationHistory, apiKey, model, baseUrl, endpointPath, timeoutMs);

    let tokensUsed = 0;
    if (summaryResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });
      tokensUsed = summaryResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
    }

    await processAgentResponse(
      summaryResponse.content || '', session, this.dbManager, this.sessionManager,
      worker, tokensUsed, originalTimestamp, 'CustomOpenAI', lastCwd, model
    );
  }

  /**
   * Handle errors from session processing: abort re-throw, fallback to Claude, or log and re-throw.
   */
  private async handleSessionError(error: unknown, session: ActiveSession, worker?: WorkerRef): Promise<never | void> {
    if (isAbortError(error)) {
      logger.warn('SDK', 'Custom OpenAI agent aborted', { sessionId: session.sessionDbId });
      throw error;
    }

    if (shouldFallbackToClaude(error) && this.fallbackAgent) {
      logger.warn('SDK', 'OpenRouter API failed, falling back to Claude SDK', {
        sessionDbId: session.sessionDbId,
        error: error instanceof Error ? error.message : String(error),
        historyLength: session.conversationHistory.length
      });

      // Fall back to Claude - it will use the same session with shared conversationHistory
      // Note: With claim-and-delete queue pattern, messages are already deleted on claim
      await this.fallbackAgent.startSession(session, worker);
      return;
    }

    logger.failure('SDK', 'Custom OpenAI agent error', { sessionDbId: session.sessionDbId }, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  /**
   * Estimate token count from text (conservative estimate)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  /**
   * Truncate conversation history to prevent runaway context costs
   * Keeps most recent messages within token budget
   */
  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    const MAX_CONTEXT_MESSAGES = parseInt(settings.CLAUDE_MEM_CUSTOM_OPENAI_MAX_CONTEXT_MESSAGES) || DEFAULT_MAX_CONTEXT_MESSAGES;
    const MAX_ESTIMATED_TOKENS = parseInt(settings.CLAUDE_MEM_CUSTOM_OPENAI_MAX_TOKENS) || DEFAULT_MAX_ESTIMATED_TOKENS;

    if (history.length <= MAX_CONTEXT_MESSAGES) {
      // Check token count even if message count is ok
      const totalTokens = history.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
      if (totalTokens <= MAX_ESTIMATED_TOKENS) {
        return history;
      }
    }

    // Sliding window: keep most recent messages within limits
    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    // Process messages in reverse (most recent first)
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const msgTokens = this.estimateTokens(msg.content);

      if (truncated.length >= MAX_CONTEXT_MESSAGES || tokenCount + msgTokens > MAX_ESTIMATED_TOKENS) {
        logger.warn('SDK', 'Context window truncated to prevent runaway costs', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          droppedMessages: i + 1,
          estimatedTokens: tokenCount,
          tokenLimit: MAX_ESTIMATED_TOKENS
        });
        break;
      }

      truncated.unshift(msg);  // Add to beginning
      tokenCount += msgTokens;
    }

    return truncated;
  }

  /**
   * Convert shared ConversationMessage array to OpenAI-compatible message format
   */
  private conversationToOpenAIMessages(history: ConversationMessage[]): OpenAIMessage[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));
  }

  /**
   * Query OpenRouter via REST API with full conversation history (multi-turn)
   * Sends the entire conversation context for coherent responses
   */
  private async queryCustomOpenAIMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    model: string,
    baseUrl: string,
    endpointPath: string,
    timeoutMs: number
  ): Promise<{ content: string; tokensUsed?: number }> {
    // Truncate history to prevent runaway costs
    const truncatedHistory = this.truncateHistory(history);
    const messages = this.conversationToOpenAIMessages(truncatedHistory);
    const totalChars = truncatedHistory.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = this.estimateTokens(truncatedHistory.map(m => m.content).join(''));

    logger.debug('SDK', `Querying Custom OpenAI multi-turn (${model})`, {
      turns: truncatedHistory.length,
      totalChars,
      estimatedTokens
    });

    const url = `${baseUrl.replace(/\/$/, '')}${endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        max_tokens: 4096,
        stream: false,
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    logger.debug('SDK', 'Custom OpenAI request complete', {
      url,
      model,
      status: response.status,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Custom OpenAI API error: ${response.status} - ${errorText}`);
    }

    const responseText = await response.text();
    let data: CustomOpenAIResponse;
    try {
      data = JSON.parse(responseText) as CustomOpenAIResponse;
    } catch (parseError) {
      const snippet = responseText.substring(0, 200);
      logger.error('SDK', 'Custom OpenAI API returned non-JSON response', {
        url,
        model,
        status: response.status,
        snippet
      }, parseError instanceof Error ? parseError : new Error(String(parseError)));
      throw new Error(`Custom OpenAI API returned non-JSON response (status ${response.status}): ${snippet}`);
    }

    // Check for API error in response body
    if (data.error) {
      throw new Error(`Custom OpenAI API error: ${data.error.code} - ${data.error.message}`);
    }

    if (!data.choices?.[0]?.message?.content) {
      logger.error('SDK', 'Empty response from Custom OpenAI');
      return { content: '' };
    }

    const content = data.choices[0].message.content;
    const tokensUsed = data.usage?.total_tokens;

    // Log actual token usage for cost tracking
    if (tokensUsed) {
      const inputTokens = data.usage?.prompt_tokens || 0;
      const outputTokens = data.usage?.completion_tokens || 0;
      // Token usage (cost varies by model - many OpenRouter models are free)
      const estimatedCost = (inputTokens / 1000000 * 3) + (outputTokens / 1000000 * 15);

      logger.info('SDK', 'Custom OpenAI API usage', {
        model,
        inputTokens,
        outputTokens,
        totalTokens: tokensUsed,
        estimatedCostUSD: estimatedCost.toFixed(4),
        messagesInContext: truncatedHistory.length
      });

      // Warn if costs are getting high
      if (tokensUsed > 50000) {
        logger.warn('SDK', 'High token usage detected - consider reducing context', {
          totalTokens: tokensUsed,
          estimatedCost: estimatedCost.toFixed(4)
        });
      }
    }

    return { content, tokensUsed };
  }

  /**
   * Get OpenRouter configuration from settings or environment
   * Issue #733: Uses centralized ~/.claude-mem/.env for credentials, not random project .env files
   */
  private getCustomOpenAIConfig(): {
    apiKey: string;
    model: string;
    baseUrl: string;
    path: string;
    timeoutMs: number;
  } {
    const settingsPath = USER_SETTINGS_PATH;
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    const apiKey = settings.CLAUDE_MEM_CUSTOM_OPENAI_API_KEY || getCredential('CUSTOM_OPENAI_API_KEY') || '';
    const model = settings.CLAUDE_MEM_CUSTOM_OPENAI_MODEL || 'if/kimi-k2-thinking';
    const baseUrl = settings.CLAUDE_MEM_CUSTOM_OPENAI_BASE_URL || DEFAULT_CUSTOM_OPENAI_BASE_URL;
    const path = settings.CLAUDE_MEM_CUSTOM_OPENAI_PATH || DEFAULT_CUSTOM_OPENAI_PATH;
    const timeoutMs = parseInt(settings.CLAUDE_MEM_CUSTOM_OPENAI_TIMEOUT_MS || '120000', 10) || 120000;

    return { apiKey, model, baseUrl, path, timeoutMs };
  }
}

/**
 * Check if OpenRouter is available (has API key configured)
 * Issue #733: Uses centralized ~/.claude-mem/.env, not random project .env files
 */
export function isCustomOpenAIAvailable(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return !!(settings.CLAUDE_MEM_CUSTOM_OPENAI_MODEL && settings.CLAUDE_MEM_CUSTOM_OPENAI_BASE_URL);
}

/**
 * Check if OpenRouter is the selected provider
 */
export function isCustomOpenAISelected(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'custom_openai';
}
