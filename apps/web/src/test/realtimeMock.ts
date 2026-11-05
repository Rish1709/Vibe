import type { ServerToClientEvents } from '@vibe/shared';

type Listener = (payload: unknown) => void;

/**
 * Stands in for the Socket.IO connection in UI tests: records what the app emits and lets a test
 * play the server with `serverEmit`.
 */
class FakeSocket {
  connected = false;
  readonly emitted: { event: string; payload: unknown }[] = [];
  private listeners = new Map<string, Set<Listener>>();

  connect() {
    this.connected = true;
    this.fire('connect', undefined);
    return this;
  }
  disconnect() {
    this.connected = false;
    return this;
  }
  on(event: string, listener: Listener) {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }
  off(event: string, listener?: Listener) {
    if (listener) this.listeners.get(event)?.delete(listener);
    else this.listeners.delete(event);
    return this;
  }
  emit(event: string, payload: unknown) {
    this.emitted.push({ event, payload });
    return this;
  }
  serverEmit<E extends keyof ServerToClientEvents>(
    event: E,
    payload: Parameters<ServerToClientEvents[E]>[0],
  ) {
    this.fire(event, payload);
  }
  reset() {
    this.listeners.clear();
    this.emitted.length = 0;
    this.connected = false;
  }
  private fire(event: string, payload: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

export const fakeSocket = new FakeSocket();
export const realtimeModule = { getSocket: () => fakeSocket };
