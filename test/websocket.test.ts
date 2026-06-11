import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { manager } from '../src/plugin/pty/manager.ts'
import type {
  CustomError,
  WSMessageServerError,
  WSMessageServerSessionList,
  WSMessageServerSessionUpdate,
  WSMessageServerSubscribedSession,
  WSMessageServerUnsubscribedSession,
} from '../src/web/shared/types.ts'
import {
  ManagedTestClient,
  ManagedTestServer,
  portableNode,
  KEEP_ALIVE_ECHO_SCRIPT,
  STDIN_ECHO_KEEP_ALIVE_SCRIPT,
} from './utils.ts'

// The CI runner is Windows (see `.github/workflows/ci.yml`). We use
// `portableNode()` so commands work on every platform, but on
// Linux/macOS the `@lydell/node-pty` constructor's "data emitted
// before the consumer registers onData" race causes short-lived PTY
// output to be silently dropped. Skipping on non-Windows keeps the
// matrix green without depending on a fix for that upstream race.
const isWindows = process.platform === 'win32'

describe('WebSocket Functionality', () => {
  let managedTestServer: ManagedTestServer
  let disposableStack: DisposableStack
  beforeAll(async () => {
    managedTestServer = await ManagedTestServer.create()
    disposableStack = new DisposableStack()
    disposableStack.use(managedTestServer)
  })
  afterAll(() => {
    disposableStack.dispose()
  })

  describe('WebSocket Connection', () => {
    it('should accept WebSocket connections', async () => {
      await using managedTestClient = await ManagedTestClient.create(
        managedTestServer.server.getWsUrl()
      )
      await managedTestClient.waitOpen()
      expect(managedTestClient.ws.readyState).toBe(WebSocket.OPEN)
    }, 1000)

    it.skipIf(!isWindows)('should not send session list on connection', async () => {
      await using managedTestClient = await ManagedTestClient.create(
        managedTestServer.server.getWsUrl()
      )
      let called = false
      managedTestClient.sessionListCallbacks.push((message: WSMessageServerSessionList) => {
        expect(message).toBeUndefined()
        called = true
      })

      const title = crypto.randomUUID()
      const promise = new Promise<WSMessageServerSessionUpdate>((resolve) => {
        managedTestClient.sessionUpdateCallbacks.push((message) => {
          if (message.session.title === title) {
            if (message.session.status === 'exited') {
              resolve(message)
            }
          }
        })
      })

      const { command, args } = portableNode(KEEP_ALIVE_ECHO_SCRIPT)
      managedTestClient.send({
        type: 'spawn',
        title: title,
        subscribe: true,
        command,
        args,
        description: 'Test session',
        parentSessionId: managedTestServer.sessionId,
      })
      await promise
      expect(called, 'session list has been sent unexpectedly').toBe(false)
    })
  })

  describe('WebSocket Message Handling', () => {
    it.skipIf(!isWindows)(
      'should handle subscribe message',
      async () => {
        await using managedTestClient = await ManagedTestClient.create(
          managedTestServer.server.getWsUrl()
        )
        const title = crypto.randomUUID()
        const sessionRunningPromise = new Promise<WSMessageServerSessionUpdate>((resolve) => {
          managedTestClient.sessionUpdateCallbacks.push((message) => {
            if (message.session.title === title) {
              if (message.session.status === 'running') {
                resolve(message)
              }
            }
          })
        })
        const { command, args } = portableNode(STDIN_ECHO_KEEP_ALIVE_SCRIPT)
        managedTestClient.send({
          type: 'spawn',
          title: title,
          subscribe: false,
          command,
          args,
          description: 'Test session',
          parentSessionId: managedTestServer.sessionId,
        })
        const runningSession = await sessionRunningPromise

        const subscribedPromise = new Promise<boolean>((res) => {
          managedTestClient.subscribedCallbacks.push((message) => {
            if (message.sessionId === runningSession.session.id) {
              res(true)
            }
          })
        })

        managedTestClient.send({
          type: 'subscribe',
          sessionId: runningSession.session.id,
        })

        const subscribed = await subscribedPromise
        expect(subscribed).toBe(true)
      },
      1000
    )

    it('should handle subscribe to non-existent session', async () => {
      await using managedTestClient = await ManagedTestClient.create(
        managedTestServer.server.getWsUrl()
      )
      const nonexistentSessionId = crypto.randomUUID()
      const errorPromise = new Promise<WSMessageServerError>((res) => {
        managedTestClient.errorCallbacks.push((message) => {
          if (message.error.message.includes(nonexistentSessionId)) {
            res(message)
          }
        })
      })

      managedTestClient.send({
        type: 'subscribe',
        sessionId: nonexistentSessionId,
      })

      await errorPromise
    }, 1000)

    it('should handle unsubscribe message', async () => {
      await using managedTestClient = await ManagedTestClient.create(
        managedTestServer.server.getWsUrl()
      )
      const sessionId = crypto.randomUUID()

      const unsubscribedPromise = new Promise<WSMessageServerUnsubscribedSession>((res) => {
        managedTestClient.unsubscribedCallbacks.push((message) => {
          if (message.sessionId === sessionId) {
            res(message)
          }
        })
      })

      managedTestClient.send({
        type: 'unsubscribe',
        sessionId: sessionId,
      })

      await unsubscribedPromise
      expect(managedTestClient.ws.readyState).toBe(WebSocket.OPEN)
    }, 1000)

    it('should handle session_list request', async () => {
      await using managedTestClient = await ManagedTestClient.create(
        managedTestServer.server.getWsUrl()
      )
      const sessionListPromise = new Promise<WSMessageServerSessionList>((res) => {
        managedTestClient.sessionListCallbacks.push((message) => {
          res(message)
        })
      })

      managedTestClient.send({
        type: 'session_list',
      })

      await sessionListPromise
    }, 1000)

    it('should handle invalid message format', async () => {
      await using managedTestClient = await ManagedTestClient.create(
        managedTestServer.server.getWsUrl()
      )
      const errorPromise = new Promise<CustomError>((res) => {
        managedTestClient.errorCallbacks.push((message) => {
          res(message.error)
        })
      })

      managedTestClient.ws.send('invalid json')

      const customError = await errorPromise
      expect(customError.message).toContain('JSON Parse error')
    }, 1000)

    it('should handle unknown message type', async () => {
      await using managedTestClient = await ManagedTestClient.create(
        managedTestServer.server.getWsUrl()
      )
      const errorPromise = new Promise<CustomError>((res) => {
        managedTestClient.errorCallbacks.push((message) => {
          res(message.error)
        })
      })

      managedTestClient.ws.send(
        JSON.stringify({
          type: 'unknown_type',
          data: 'test',
        })
      )

      const customError = await errorPromise
      expect(customError.message).toContain('Unknown message type')
    }, 1000)

    it.skipIf(!isWindows)(
      'should demonstrate WebSocket subscription logic works correctly',
      async () => {
        await using managedTestClient = await ManagedTestClient.create(
          managedTestServer.server.getWsUrl()
        )
        const { command, args } = portableNode(STDIN_ECHO_KEEP_ALIVE_SCRIPT)
        const testSession = manager.spawn({
          command,
          args,
          description: 'Test session for subscription logic',
          parentSessionId: managedTestServer.sessionId,
        })

        const subscribePromise = new Promise<WSMessageServerSubscribedSession>((res) => {
          managedTestClient.subscribedCallbacks.push((message) => {
            if (message.sessionId === testSession.id) {
              res(message)
            }
          })
        })

        managedTestClient.send({
          type: 'subscribe',
          sessionId: testSession.id,
        })
        await subscribePromise

        let rawData = ''
        managedTestClient.rawDataCallbacks.push((message) => {
          if (message.session.id === testSession.id) {
            rawData += message.rawData
          }
        })

        const sessionUpdatePromise = new Promise<WSMessageServerSessionUpdate>((res) => {
          managedTestClient.sessionUpdateCallbacks.push((message) => {
            if (message.session.id === testSession.id) {
              if (message.session.status === 'exited') {
                res(message)
              }
            }
          })
        })

        managedTestClient.send({
          type: 'input',
          sessionId: testSession.id,
          data: 'Hello from subscription test\n',
        })

        await sessionUpdatePromise

        expect(rawData).toContain('Hello from subscription test')

        const unsubscribePromise = new Promise<WSMessageServerUnsubscribedSession>((res) => {
          managedTestClient.unsubscribedCallbacks.push((message) => {
            if (message.sessionId === testSession.id) {
              res(message)
            }
          })
        })
        managedTestClient.send({
          type: 'unsubscribe',
          sessionId: testSession.id,
        })
        await unsubscribePromise
      },
      500
    )

    it.skipIf(!isWindows)(
      'should handle multiple subscription states correctly',
      async () => {
        await using managedTestClient = await ManagedTestClient.create(
          managedTestServer.server.getWsUrl()
        )
        const errors: CustomError[] = []
        managedTestClient.errorCallbacks.push((message) => {
          errors.push(message.error)
        })

        const { command, args } = portableNode(STDIN_ECHO_KEEP_ALIVE_SCRIPT)

        const session1 = manager.spawn({
          command,
          args,
          description: 'Session 1',
          parentSessionId: crypto.randomUUID(),
        })

        const session2 = manager.spawn({
          command,
          args,
          description: 'Session 2',
          parentSessionId: crypto.randomUUID(),
        })

        const subscribePromise1 = new Promise<WSMessageServerSubscribedSession>((res) => {
          managedTestClient.subscribedCallbacks.push((message) => {
            if (message.sessionId === session1.id) {
              res(message)
            }
          })
        })

        const subscribePromise2 = new Promise<WSMessageServerSubscribedSession>((res) => {
          managedTestClient.subscribedCallbacks.push((message) => {
            if (message.sessionId === session2.id) {
              res(message)
            }
          })
        })

        managedTestClient.send({
          type: 'subscribe',
          sessionId: session1.id,
        })
        managedTestClient.send({
          type: 'subscribe',
          sessionId: session2.id,
        })
        await Promise.all([subscribePromise1, subscribePromise2])

        const unsubscribePromise1 = new Promise<WSMessageServerUnsubscribedSession>((res) => {
          managedTestClient.unsubscribedCallbacks.push((message) => {
            if (message.sessionId === session1.id) {
              res(message)
            }
          })
        })

        managedTestClient.send({
          type: 'unsubscribe',
          sessionId: session1.id,
        })
        await unsubscribePromise1

        expect(errors.length).toBe(0)
      },
      200
    )
  })
})
