/**
 * Session Manager
 *
 * Manages multiple parallel browser sessions for NotebookLM API
 *
 * Features:
 * - Session lifecycle management
 * - Auto-cleanup of inactive sessions
 * - Resource limits (max concurrent sessions)
 * - Shared PERSISTENT browser fingerprint (ONE context for all sessions)
 *
 * Based on the Python implementation from session_manager.py
 */

import type { AuthManager } from "../auth/auth-manager.js";
import { BrowserSession } from "./browser-session.js";
import { SharedContextManager } from "./shared-context-manager.js";
import { CONFIG } from "../config.js";
import { log } from "../utils/logger.js";
import type { SessionInfo } from "../types.js";
import { randomBytes } from "crypto";
import { getNotebookLmId } from "../notebooklm/notebook-url.js";

export interface SessionManagerOptions {
  sharedContextManager?: SharedContextManager;
  createSession?: (
    sessionId: string,
    sharedContextManager: SharedContextManager,
    authManager: AuthManager,
    notebookUrl: string
  ) => BrowserSession;
}

export class SessionManager {
  private authManager: AuthManager;
  private sharedContextManager: SharedContextManager;
  private sessions: Map<string, BrowserSession> = new Map();
  private pendingCreations: Map<
    string,
    { notebookUrl: string; overrideHeadless?: boolean; promise: Promise<BrowserSession> }
  > = new Map();
  private maxSessions: number;
  private sessionTimeout: number;
  private cleanupInterval?: NodeJS.Timeout;
  private createSession: NonNullable<SessionManagerOptions["createSession"]>;
  private lifecycleTail: Promise<void> = Promise.resolve();

  constructor(authManager: AuthManager, options: SessionManagerOptions = {}) {
    this.authManager = authManager;
    this.sharedContextManager =
      options.sharedContextManager ?? new SharedContextManager(authManager);
    this.createSession =
      options.createSession ??
      ((sessionId, contextManager, manager, notebookUrl) =>
        new BrowserSession(sessionId, contextManager, manager, notebookUrl));
    this.maxSessions = CONFIG.maxSessions;
    this.sessionTimeout = CONFIG.sessionTimeout;

    log.info("🎯 SessionManager initialized");
    log.info(`  Max sessions: ${this.maxSessions}`);
    log.info(
      `  Timeout: ${this.sessionTimeout}s (${Math.floor(this.sessionTimeout / 60)} minutes)`
    );

    const cleanupIntervalSeconds = Math.max(60, Math.min(Math.floor(this.sessionTimeout / 2), 300));
    this.cleanupInterval = setInterval(() => {
      this.cleanupInactiveSessions().catch((error) => {
        log.warning(`⚠️  Error during automatic session cleanup: ${error}`);
      });
    }, cleanupIntervalSeconds * 1000);
    this.cleanupInterval.unref();
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    return randomBytes(4).toString("hex");
  }

  /**
   * Get existing session or create a new one
   *
   * @param sessionId Optional session ID to reuse existing session
   * @param notebookUrl Notebook URL for the session
   * @param overrideHeadless Optional override for headless mode (true = show browser)
   */
  async getOrCreateSession(
    sessionId?: string,
    notebookUrl?: string,
    overrideHeadless?: boolean
  ): Promise<BrowserSession> {
    // Determine target notebook URL
    const targetUrl = (notebookUrl || CONFIG.notebookUrl || "").trim();
    if (!targetUrl) {
      throw new Error("Notebook URL is required to create a session");
    }
    const targetNotebookId = getNotebookLmId(targetUrl);

    // Generate ID if not provided
    if (!sessionId) {
      sessionId = this.generateSessionId();
      log.info(`🆕 Auto-generated session ID: ${sessionId}`);
    }

    // Deduplicate same-session creation before touching the shared browser
    // context. A different request for the same id waits for the in-flight
    // creation and then re-enters normal replacement/mode-change handling.
    const pending = this.pendingCreations.get(sessionId);
    if (pending) {
      if (
        getNotebookLmId(pending.notebookUrl) === targetNotebookId &&
        pending.overrideHeadless === overrideHeadless
      ) {
        return pending.promise;
      }
      await pending.promise.catch(() => undefined);
      return this.getOrCreateSession(sessionId, targetUrl, overrideHeadless);
    }

    const creation = this.withLifecycleLock(() =>
      this.createOrReuseSession(sessionId, targetUrl, overrideHeadless)
    );
    this.pendingCreations.set(sessionId, {
      notebookUrl: targetUrl,
      overrideHeadless,
      promise: creation,
    });
    try {
      return await creation;
    } finally {
      if (this.pendingCreations.get(sessionId)?.promise === creation) {
        this.pendingCreations.delete(sessionId);
      }
    }
  }

  private async withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTail;
    let release!: () => void;
    this.lifecycleTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async createOrReuseSession(
    sessionId: string,
    targetUrl: string,
    overrideHeadless?: boolean
  ): Promise<BrowserSession> {
    // Check if browser visibility mode needs to change
    if (overrideHeadless !== undefined) {
      if (this.sharedContextManager.needsHeadlessModeChange(overrideHeadless)) {
        if (this.sessions.size > 0) {
          throw new Error(
            "Cannot change browser visibility while sessions are active. Close active sessions first."
          );
        }
        log.warning(
          `🔄 Browser visibility changed - closing all sessions to recreate browser context...`
        );
        const currentMode = this.sharedContextManager.getCurrentHeadlessMode();
        log.info(
          `  Switching from ${currentMode ? "HEADLESS" : "VISIBLE"} to ${overrideHeadless ? "VISIBLE" : "HEADLESS"}`
        );

        // Close all sessions (they all use the same context)
        await this.closeAllSessionsUnlocked();
        log.success(`  ✅ All sessions closed, browser context will be recreated with new mode`);
      }
    }

    // Return existing session if found
    if (this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId)!;
      if (getNotebookLmId(session.notebookUrl) !== getNotebookLmId(targetUrl)) {
        log.warning(`♻️  Replacing session ${sessionId} with new notebook URL`);
        try {
          await session.close();
        } finally {
          this.sessions.delete(sessionId);
        }
      } else {
        session.updateActivity();
        log.success(`♻️  Reusing existing session ${sessionId}`);
        return session;
      }
    }

    // Check if we need to free up space
    if (this.sessions.size >= this.maxSessions) {
      log.warning(`⚠️  Max sessions (${this.maxSessions}) reached, cleaning up...`);
      const freed = await this.cleanupOldestSessionUnlocked();
      if (!freed) {
        throw new Error(
          `Max sessions (${this.maxSessions}) reached and no inactive sessions to clean up`
        );
      }
    }

    // Create new session
    log.info(`🆕 Creating new session ${sessionId}...`);
    if (overrideHeadless !== undefined) {
      log.info(`  Show browser: ${overrideHeadless}`);
    }
    try {
      // Ensure the shared context exists (ONE fingerprint for all sessions!)
      await this.sharedContextManager.getOrCreateContext(overrideHeadless);

      // Create and initialize session
      const session = this.createSession(
        sessionId,
        this.sharedContextManager,
        this.authManager,
        targetUrl
      );
      await session.init();

      this.sessions.set(sessionId, session);
      log.success(
        `✅ Session ${sessionId} created (${this.sessions.size}/${this.maxSessions} active)`
      );
      return session;
    } catch (error) {
      log.error(`❌ Failed to create session: ${error}`);
      throw error;
    }
  }

  /**
   * Get an existing session by ID
   */
  getSession(sessionId: string): BrowserSession | null {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Close and remove a specific session
   */
  async closeSession(sessionId: string): Promise<boolean> {
    return this.withLifecycleLock(() => this.closeSessionUnlocked(sessionId));
  }

  private async closeSessionUnlocked(sessionId: string): Promise<boolean> {
    if (!this.sessions.has(sessionId)) {
      log.warning(`⚠️  Session ${sessionId} not found`);
      return false;
    }

    const session = this.sessions.get(sessionId)!;
    try {
      await session.close();
    } finally {
      this.sessions.delete(sessionId);
    }

    log.success(
      `✅ Session ${sessionId} closed (${this.sessions.size}/${this.maxSessions} active)`
    );
    return true;
  }

  /**
   * Close all sessions that are using the provided notebook URL
   */
  async closeSessionsForNotebook(url: string): Promise<number> {
    return this.withLifecycleLock(() => this.closeSessionsForNotebookUnlocked(url));
  }

  private async closeSessionsForNotebookUnlocked(url: string): Promise<number> {
    const notebookId = getNotebookLmId(url);
    let closed = 0;

    for (const [sessionId, session] of Array.from(this.sessions.entries())) {
      if (getNotebookLmId(session.notebookUrl) === notebookId) {
        try {
          await session.close();
        } catch (error) {
          log.warning(`  ⚠️  Error closing ${sessionId}: ${error}`);
        } finally {
          this.sessions.delete(sessionId);
          closed++;
        }
      }
    }

    if (closed > 0) {
      log.warning(
        `🧹 Closed ${closed} session(s) using removed notebook (${this.sessions.size}/${this.maxSessions} active)`
      );
    }

    return closed;
  }

  /**
   * Clean up all inactive sessions
   */
  async cleanupInactiveSessions(): Promise<number> {
    return this.withLifecycleLock(() => this.cleanupInactiveSessionsUnlocked());
  }

  private async cleanupInactiveSessionsUnlocked(): Promise<number> {
    const inactiveSessions: string[] = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.isExpired(this.sessionTimeout)) {
        inactiveSessions.push(sessionId);
      }
    }

    if (inactiveSessions.length === 0) {
      return 0;
    }

    log.warning(`🧹 Cleaning up ${inactiveSessions.length} inactive sessions...`);

    for (const sessionId of inactiveSessions) {
      try {
        const session = this.sessions.get(sessionId)!;
        const age = (Date.now() - session.createdAt) / 1000;
        const inactive = (Date.now() - session.lastActivity) / 1000;

        log.warning(
          `  🗑️  ${sessionId}: age=${age.toFixed(0)}s, inactive=${inactive.toFixed(0)}s, messages=${session.messageCount}`
        );

        try {
          await session.close();
        } finally {
          this.sessions.delete(sessionId);
        }
      } catch (error) {
        log.warning(`  ⚠️  Error cleaning up ${sessionId}: ${error}`);
      }
    }

    log.success(
      `✅ Cleaned up ${inactiveSessions.length} sessions (${this.sessions.size}/${this.maxSessions} active)`
    );
    return inactiveSessions.length;
  }

  /**
   * Clean up the oldest session to make space
   */
  private async cleanupOldestSessionUnlocked(): Promise<boolean> {
    if (this.sessions.size === 0) {
      return false;
    }

    // Find oldest session
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.createdAt < oldestTime) {
        oldestTime = session.createdAt;
        oldestId = sessionId;
      }
    }

    if (!oldestId) {
      return false;
    }

    const oldestSession = this.sessions.get(oldestId)!;
    const age = (Date.now() - oldestSession.createdAt) / 1000;

    log.warning(`🗑️  Removing oldest session ${oldestId} (age: ${age.toFixed(0)}s)`);

    try {
      await oldestSession.close();
    } finally {
      this.sessions.delete(oldestId);
    }

    return true;
  }

  /**
   * Close all sessions (used during shutdown)
   */
  async closeAllSessions(): Promise<void> {
    await this.withLifecycleLock(() => this.closeAllSessionsUnlocked());
  }

  private async closeAllSessionsUnlocked(): Promise<void> {
    if (this.sessions.size === 0) {
      log.warning("🛑 Closing shared context (no active sessions)...");
      await this.sharedContextManager.closeContext();
      log.success("✅ All sessions closed");
      return;
    }

    log.warning(`🛑 Closing all ${this.sessions.size} sessions...`);

    for (const sessionId of Array.from(this.sessions.keys())) {
      try {
        const session = this.sessions.get(sessionId)!;
        await session.close();
      } catch (error) {
        log.warning(`  ⚠️  Error closing ${sessionId}: ${error}`);
      } finally {
        this.sessions.delete(sessionId);
      }
    }

    // Close the shared context
    await this.sharedContextManager.closeContext();

    log.success("✅ All sessions closed");
  }

  /**
   * Get all sessions info
   */
  getAllSessionsInfo(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((session) => session.getInfo());
  }

  /**
   * Get aggregate stats
   */
  getStats(): {
    active_sessions: number;
    max_sessions: number;
    session_timeout: number;
    oldest_session_seconds: number;
    total_messages: number;
  } {
    const sessionsInfo = this.getAllSessionsInfo();

    const totalMessages = sessionsInfo.reduce((sum, info) => sum + info.message_count, 0);
    const oldestSessionSeconds = Math.max(...sessionsInfo.map((info) => info.age_seconds), 0);

    return {
      active_sessions: sessionsInfo.length,
      max_sessions: this.maxSessions,
      session_timeout: this.sessionTimeout,
      oldest_session_seconds: oldestSessionSeconds,
      total_messages: totalMessages,
    };
  }

  /** Offline health uses this cached live-readiness fact; it never creates a browser. */
  isRuntimeVerified(): boolean {
    return this.sharedContextManager.isRuntimeVerified();
  }
}
