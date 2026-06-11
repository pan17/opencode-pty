import { createRequire } from 'node:module'

// @lydell/node-pty only exports `spawn` from its public API, but its
// `terminal.js` file is reachable via deep import because the package's
// package.json has no `exports` field. We load it through `createRequire`
// to side-step the absence of TypeScript declarations for the deep
// path; the module is typed locally so call sites stay type-safe.

interface TerminalInstance {
  _onData: { fire(data: unknown): boolean }
  _forwardEvents(): void
  _socket?: NodeJS.WritableStream & NodeJS.EventEmitter
  _agent?: {
    inSocket: NodeJS.WritableStream & NodeJS.EventEmitter
    outSocket: NodeJS.WritableStream & NodeJS.EventEmitter
  }
}

interface TerminalConstructor {
  prototype: TerminalInstance
}

interface TerminalModule {
  Terminal: TerminalConstructor
}

const nodeRequire = createRequire(import.meta.url)
const { Terminal } = nodeRequire('@lydell/node-pty/terminal.js') as TerminalModule

const replayBuffers = new WeakMap<TerminalInstance, string[]>()
let patchInstalled = false

/**
 * Install a per-instance replay-buffer patch on
 * `Terminal.prototype._forwardEvents`. The patch is idempotent.
 *
 * The race we are closing: `@lydell/node-pty`'s `Terminal` constructor
 * ends with a call to `_forwardEvents()`, which in turn does
 * `this.on('data', cb)` → `this._socket.on('data', cb)`. Adding a
 * 'data' listener to a `tty.ReadStream` switches it to flowing mode
 * and any bytes already sitting in the kernel PTY buffer are
 * delivered to the listener SYNCHRONOUSLY (during the same
 * constructor call). The listener invokes `_onData.fire(e)`, but the
 * `_onData` EventEmitter2 has zero listeners at this point — the
 * consumer calls `pty.onData(...)` only AFTER `spawn()` returns. For
 * short-lived commands (`echo Hello World`) the child process has
 * already exited by the time the constructor finishes, so the data
 * is emitted and silently lost.
 *
 * The fix: override `_forwardEvents` to install a per-instance replay
 * buffer (stored in a `WeakMap` keyed by the Terminal instance)
 * BEFORE the 'data' listener is added. The buffer captures every
 * `fire` call until the consumer drains it via `drainReplayBuffer`.
 * The consumer drains right after wiring its real `onData` handler in
 * `SessionLifecycleManager.spawn()`, so subscribers see a complete
 * stream from byte zero.
 *
 * This race affects BOTH Windows (conpty) and Linux (UnixTerminal).
 *
 * Inspired by https://github.com/sursaone/bun-pty/pull/37 (the
 * bun-pty fix that this is the @lydell/node-pty equivalent of).
 *
 * Side-effect: this MUST run before the first `spawn()` call. It is
 * imported as a side-effect from `session-lifecycle.ts` and called
 * once at module top-level.
 */
export function installMonoPatch(): void {
  if (patchInstalled) {
    return
  }
  patchInstalled = true

  const proto = Terminal.prototype
  const originalForward = proto._forwardEvents

  proto._forwardEvents = function (this: TerminalInstance): void {
    const buffer: string[] = []
    replayBuffers.set(this, buffer)

    const onDataEmitter = this._onData
    const originalFire = onDataEmitter.fire.bind(onDataEmitter)
    onDataEmitter.fire = (data: unknown): boolean => {
      if (typeof data === 'string') {
        buffer.push(data)
      } else if (data instanceof Uint8Array) {
        buffer.push(new TextDecoder('utf-8').decode(data))
      }
      return originalFire(data)
    }

    // Suppress "Socket is closed" / ERR_SOCKET_CLOSED from the underlying
    // net.Socket when write() is called after the conpty session has ended.
    // Without this listener Bun/Node treats the async error event as an
    // unhandled exception that cannot be caught by try-catch in OutputManager.
    //
    // On Windows, writing goes through _agent.inSocket (the input pipe),
    // while _socket is the output/read pipe — suppress errors on BOTH.
    const sockets = []
    if (this._socket && typeof this._socket.on === 'function') {
      sockets.push(this._socket)
    }
    if (this._agent?.inSocket && typeof this._agent.inSocket.on === 'function') {
      sockets.push(this._agent.inSocket)
    }
    for (const sock of sockets) {
      sock.on('error', () => {
        // swallow — socket was closed before write completed
      })
    }

    originalForward.call(this)
  }
}

/**
 * Drain and clear the replay buffer for a given PTY. Returns the
 * buffered chunks in arrival order. The buffer entry is removed
 * from the `WeakMap`; subsequent `_onData.fire` calls (e.g. late
 * data arriving after the consumer registered `onData`) still flow
 * through the wrap, which now only forwards to the original `fire`
 * (i.e. the consumer's listener). The wrap's closure stays alive
 * until the PTY itself is garbage-collected, which is acceptable.
 */
export function drainReplayBuffer(pty: TerminalInstance): string[] {
  const buf = replayBuffers.get(pty) ?? []
  replayBuffers.delete(pty)
  return buf
}
