import type { SessionContextSnapshot, SessionDescriptor } from '@flrande/bak-protocol';

export interface SessionState extends SessionDescriptor {
  bindingId: string;
  bindingInitialized: boolean;
  activeTabId: number | null;
  traceId: string;
  contextsByTab: Map<number, { framePath: string[]; shadowPath: string[] }>;
}

export interface SessionBindingLike {
  id?: string;
  tabIds: number[];
  activeTabId: number | null;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionState>();

  list(): SessionState[] {
    return [...this.sessions.values()].map((session) => this.cloneSession(session));
  }

  create(session: SessionState): SessionState {
    this.sessions.set(session.sessionId, this.cloneSession(session));
    return this.require(session.sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get(sessionId: string): SessionState | null {
    const session = this.sessions.get(sessionId);
    return session ? this.cloneSession(session) : null;
  }

  require(sessionId: string): SessionState {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }

  close(sessionId: string): SessionState | null {
    const session = this.get(sessionId);
    if (!session) {
      return null;
    }
    this.sessions.delete(sessionId);
    return session;
  }

  touch(sessionId: string, timestamp: string): SessionState {
    const session = this.require(sessionId);
    session.lastSeenAt = timestamp;
    return this.replace(session);
  }

  syncBinding(sessionId: string, binding: SessionBindingLike): SessionState {
    const session = this.require(sessionId);
    session.bindingInitialized = true;
    if (binding.id && session.bindingId !== binding.id) {
      session.bindingId = binding.id;
    }
    const validTabIds = new Set(binding.tabIds);
    for (const tabId of session.contextsByTab.keys()) {
      if (!validTabIds.has(tabId)) {
        session.contextsByTab.delete(tabId);
      }
    }
    if (session.activeTabId !== null && !validTabIds.has(session.activeTabId)) {
      session.activeTabId = null;
    }
    if (binding.activeTabId !== null && session.activeTabId === null) {
      session.activeTabId = binding.activeTabId;
      this.ensureTabContext(session, binding.activeTabId);
    }
    return this.replace(session);
  }

  setActiveTab(sessionId: string, tabId: number | null): SessionState {
    const session = this.require(sessionId);
    session.activeTabId = tabId;
    if (tabId !== null) {
      this.ensureTabContext(session, tabId);
    }
    return this.replace(session);
  }

  clearBinding(sessionId: string): SessionState {
    const session = this.require(sessionId);
    session.bindingInitialized = false;
    session.activeTabId = null;
    session.contextsByTab.clear();
    return this.replace(session);
  }

  clearTab(sessionId: string, tabId: number): SessionState {
    const session = this.require(sessionId);
    session.contextsByTab.delete(tabId);
    if (session.activeTabId === tabId) {
      session.activeTabId = null;
    }
    return this.replace(session);
  }

  getContext(sessionId: string, tabId?: number): SessionContextSnapshot {
    const session = this.require(sessionId);
    const resolvedTabId = typeof tabId === 'number' ? tabId : session.activeTabId;
    if (resolvedTabId === null) {
      return {
        tabId: null,
        framePath: [],
        shadowPath: []
      };
    }
    const stored = session.contextsByTab.get(resolvedTabId);
    return {
      tabId: resolvedTabId,
      framePath: stored ? [...stored.framePath] : [],
      shadowPath: stored ? [...stored.shadowPath] : []
    };
  }

  setContext(sessionId: string, snapshot: SessionContextSnapshot): SessionState {
    const session = this.require(sessionId);
    if (snapshot.tabId !== null) {
      session.contextsByTab.set(snapshot.tabId, {
        framePath: [...snapshot.framePath],
        shadowPath: [...snapshot.shadowPath]
      });
      this.ensureTabContext(session, snapshot.tabId);
    }
    return this.replace(session);
  }

  private ensureTabContext(session: SessionState, tabId: number): void {
    if (!session.contextsByTab.has(tabId)) {
      session.contextsByTab.set(tabId, {
        framePath: [],
        shadowPath: []
      });
    }
  }

  private replace(session: SessionState): SessionState {
    this.sessions.set(session.sessionId, this.cloneSession(session));
    return this.require(session.sessionId);
  }

  private cloneSession(session: SessionState): SessionState {
    return {
      ...session,
      contextsByTab: new Map(
        [...session.contextsByTab.entries()].map(([tabId, value]) => [
          tabId,
          {
            framePath: [...value.framePath],
            shadowPath: [...value.shadowPath]
          }
        ])
      )
    };
  }
}
