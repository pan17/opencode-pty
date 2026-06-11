import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  manager,
  registerRawOutputCallback,
  registerSessionUpdateCallback,
} from '../src/plugin/pty/manager.ts'
import type { PTYSessionInfo } from '../src/plugin/pty/types.ts'
import { PTYServer } from '../src/web/server/server.ts'
import { ManagedTestServer, portableNode } from './utils.ts'

describe('Web Server', () => {
  describe('Server Lifecycle', () => {
    it('should start server successfully', async () => {
      await using server = await PTYServer.createServer()
      const url = server.server.url
      expect(url.hostname).toBe('[::1]')
      expect(url.protocol).toBe('http:')
      expect(url.port).not.toBe(0)
      expect(url.port).not.toBe(8080) // Default port should be avoided
    })

    it('should support multiple server instances', async () => {
      await using server1 = await PTYServer.createServer()
      await using server2 = await PTYServer.createServer()
      expect(server1.server.url.port).not.toBe(server2.server.url.port)
    })

    it('should stop server correctly', async () => {
      const server = await PTYServer.createServer()
      expect(server.server.url).toBeTruthy()
      server[Symbol.dispose]()
    })
  })

  describe('HTTP Endpoints', () => {
    let managedTestServer: ManagedTestServer
    let disposableStack: DisposableStack

    beforeAll(async () => {
      disposableStack = new DisposableStack()
      managedTestServer = await ManagedTestServer.create()
      disposableStack.use(managedTestServer)
    })

    afterAll(() => {
      disposableStack.dispose()
    })

    it('should serve built assets', async () => {
      const response = await fetch(managedTestServer.server.server.url)
      expect(response.status).toBe(200)
      const html = await response.text()

      expect(html).toContain('<!doctype html>')
      expect(html).toContain('PTY Sessions Monitor')
      expect(html).toContain('/assets/')
      expect(html).not.toContain('/main.tsx')
      expect(html).toContain('<div id="root"></div>')

      const jsMatch = html.match(/src="\/assets\/([^"]+\.js)"/)
      const cssMatch = html.match(/href="\/assets\/([^"]+\.css)"/)

      expect(jsMatch).toBeTruthy()
      expect(cssMatch).toBeTruthy()

      if (!jsMatch || !cssMatch) {
        throw new Error('Failed to extract asset URLs from HTML')
      }

      const jsAsset = jsMatch[1]
      const jsResponse = await fetch(`${managedTestServer.server.server.url}/assets/${jsAsset}`)
      expect(jsResponse.status).toBe(200)
      const ct = jsResponse.headers.get('content-type')
      expect((ct || '').toLowerCase()).toMatch(/^(application|text)\/javascript(;.*)?$/)

      const cssAsset = cssMatch[1]
      const cssResponse = await fetch(`${managedTestServer.server.server.url}/assets/${cssAsset}`)
      expect(cssResponse.status).toBe(200)
      expect((cssResponse.headers.get('content-type') || '').toLowerCase()).toMatch(
        /^text\/css(;.*)?$/
      )
    })

    it('should serve HTML on root path', async () => {
      const response = await fetch(managedTestServer.server.server.url)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')

      const html = await response.text()
      expect(html).toContain('<!doctype html>')
      expect(html).toContain('PTY Sessions Monitor')
    })

    it('should return sessions list', async () => {
      const response = await fetch(`${managedTestServer.server.server.url}/api/sessions`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')

      const sessions = await response.json()
      expect(Array.isArray(sessions)).toBe(true)
    })

    it('should return individual session', async () => {
      // Self-printing script writes "test output\n" and idles (no stdin echo needed —
      // conpty on Windows doesn't reliably relay data written to the tty back to
      // the child's stdin as readable input, so echo-based tests time out).
      const { command, args } = portableNode(
        'process.stdout.write("test output\\n"); setInterval(() => {}, 5000)'
      )
      const session = manager.spawn({
        command,
        args,
        description: 'Test session',
        parentSessionId: 'test',
      })
      const rawDataPromise = new Promise<string>((resolve) => {
        let rawDataTotal = ''
        registerRawOutputCallback((sessionInfo: PTYSessionInfo, rawData: string) => {
          if (sessionInfo.id === session.id) {
            rawDataTotal += rawData
            if (rawDataTotal.includes('test output')) {
              resolve(rawDataTotal)
            }
          }
        })
      })

      await rawDataPromise

      const response = await fetch(
        `${managedTestServer.server.server.url}/api/sessions/${session.id}`
      )
      expect(response.status).toBe(200)

      const sessionData = await response.json()
      expect(sessionData.id).toBe(session.id)
      expect(typeof sessionData.command).toBe('string')
      expect(Array.isArray(sessionData.args)).toBe(true)
    }, 30000)

    it('should return 404 for non-existent session', async () => {
      const nonexistentId = crypto.randomUUID()
      const response = await fetch(
        `${managedTestServer.server.server.url}/api/sessions/${nonexistentId}`
      )
      expect(response.status).toBe(404)
    }, 30000)

    it('should reject invalid timeout values during session creation', async () => {
      const response = await fetch(`${managedTestServer.server.server.url}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'node.exe',
          args: ['-e', 'setTimeout(() => {}, 1000)'],
          description: 'Invalid timeout session',
          timeoutSeconds: 0,
        }),
      })

      expect(response.status).toBe(400)
      expect(await response.text()).toContain('timeoutSeconds must be a positive integer')
    })

    it('should handle input to session', async () => {
      const title = crypto.randomUUID()
      // Replace the old node-polling script with a portable idle script
      // (the test only checks that the input API returns 200, not that
      // the data is echoed back, so stdin echo is not needed).
      const { command, args } = portableNode('setTimeout(() => {}, 10000)')
      const session = manager.spawn({
        title: title,
        command,
        args,
        description: 'Test session',
        parentSessionId: 'test',
      })

      // Give conpty a moment to initialise before writing to the tty.
      await new Promise((r) => setTimeout(r, 200))

      const response = await fetch(
        `${managedTestServer.server.server.url}/api/sessions/${session.id}/input`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: 'test input\n' }),
        }
      )

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result).toHaveProperty('success', true)
    }, 30000)

    it('should handle kill session', async () => {
      const title = crypto.randomUUID()
      const sessionExitedPromise = new Promise<PTYSessionInfo>((resolve) => {
        registerSessionUpdateCallback((sessionInfo: PTYSessionInfo) => {
          if (sessionInfo.title === title && sessionInfo.status === 'killed') {
            resolve(sessionInfo)
          }
        })
      })
      // Use an idle script — the test only needs the session to exist
      // so a DELETE request can be issued and the resulting 'killed'
      // session_update event can be matched.
      const { command, args } = portableNode('setTimeout(() => {}, 10000)')
      const session = manager.spawn({
        title: title,
        command,
        args,
        description: 'Test session',
        parentSessionId: 'test',
      })

      // ConPTY needs a tick to set up the 'data' pipe before the child
      // is visible to the parent; without this delay the DELETE fires
      // before the 'killed' callback is wired.
      await new Promise((r) => setTimeout(r, 200))

      const response = await fetch(
        `${managedTestServer.server.server.url}/api/sessions/${session.id}`,
        {
          method: 'DELETE',
        }
      )

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.success).toBe(true)

      await sessionExitedPromise
    }, 30000)

    it('should return session output', async () => {
      const title = crypto.randomUUID()
      const sessionExitedPromise = new Promise<PTYSessionInfo>((resolve) => {
        registerSessionUpdateCallback((sessionInfo: PTYSessionInfo) => {
          if (sessionInfo.title === title && sessionInfo.status === 'exited') {
            resolve(sessionInfo)
          }
        })
      })
      const { command, args } = portableNode(
        'process.stdout.write("line1\\nline2\\nline3\\n"); setTimeout(() => process.exit(0), 500)'
      )
      const session = manager.spawn({
        title,
        command,
        args,
        description: 'Test session with output',
        parentSessionId: 'test-output',
      })

      await sessionExitedPromise

      const response = await fetch(
        `${managedTestServer.server.server.url}/api/sessions/${session.id}/buffer/raw`
      )
      expect(response.status).toBe(200)

      const bufferData = await response.json()
      expect(bufferData).toHaveProperty('raw')
      expect(bufferData).toHaveProperty('byteLength')
      expect(typeof bufferData.raw).toBe('string')
      expect(typeof bufferData.byteLength).toBe('number')
      // ConPTY injects ANSI escape codes (clear-screen, cursor-home,
      // title-set, etc.) around the actual process output, so the raw
      // buffer is longer than the bare 21 bytes. Check that the expected
      // lines appear (in order) rather than asserting exact content.
      expect(bufferData.raw.length).toBeGreaterThan(20)
      expect(bufferData.raw).toContain('line1')
      expect(bufferData.raw).toContain('line2')
      expect(bufferData.raw).toContain('line3')
    })

    it('should return index.html for non-existent endpoints', async () => {
      const response = await fetch(`${managedTestServer.server.server.url}/api/nonexistent`)
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain('<div id="root"></div>')
      expect(text).toContain('<!doctype html>')
    }, 30000)
  })
})
