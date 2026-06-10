import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import { buildStaticRoutes } from './handlers/static.ts'
import { handleHealth } from './handlers/health.ts'
import { handleWebSocketMessage } from './handlers/websocket.ts'
import {
 cleanupSession,
 clearSessions,
 createSession,
 getPlainBuffer,
 getRawBuffer,
 getSession,
 getSessions,
 killSession,
 sendInput,
} from './handlers/sessions.ts'
import { routes } from '../shared/routes.ts'

// Adapter type: looks like Bun's BunRequest<P> but built on top of Node's IncomingMessage.
// Handlers read URL params via req.params and parse body via req.json().
export type NodeBunRequest<P = Record<string, string>> = IncomingMessage & {
 params: P
 json(): Promise<unknown>
}

// Adapter type: looks like Bun's ServerWebSocket<T> but uses `ws` package's WebSocket.
// Adds Bun-compatible topic pub/sub helpers.
type SubscriberWebSocket = WebSocket & {
 subscriptions: Set<string>
 subscribe(topic: string): void
 unsubscribe(topic: string): void
}

// Adapter type: looks like Bun.Server<undefined> from the outside, so callback-manager.ts
// and handlers can keep their `server.publish(...)` / `server.url` / `server.pendingWebSockets`
// API expectations.
export interface ServerInterface {
 url: URL
 publish(topic: string, data: string): void
 pendingWebSockets: number
}

const SECURITY_HEADERS = {
 'X-Content-Type-Options': 'nosniff',
 'X-Frame-Options': 'DENY',
 'X-XSS-Protection': '1; mode=block',
 'Referrer-Policy': 'strict-origin-when-cross-origin',
 'Content-Security-Policy':
 "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';",
} as const

function headerValue(v: string | string[] | undefined): string {
 if (Array.isArray(v)) return v[0] ?? ''
 return v ?? ''
}

export class PTYServer implements Disposable {
 public readonly server: ServerInterface
 private readonly httpServer: HttpServer
 private readonly wss: WebSocketServer
  private readonly staticRoutes: ReadonlyMap<string, { body: Buffer; contentType: string }>
 private readonly topics = new Map<string, Set<SubscriberWebSocket>>()
 private readonly stack = new DisposableStack()
 private _url?: URL

  private constructor(staticRoutes: Map<string, { body: Buffer; contentType: string }>) {
 this.staticRoutes = staticRoutes

 this.httpServer = createServer((req, res) => {
 this.handleHttp(req, res).catch((err) => {
 console.error('HTTP handler error:', err)
 if (!res.headersSent) {
 res.statusCode =500
 res.setHeader('Content-Type', 'application/json')
 }
 res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
 })
 })

 this.wss = new WebSocketServer({ noServer: true })
 this.wss.on('connection', (ws) => this.onWsConnection(ws as SubscriberWebSocket))
 this.httpServer.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as Socket, head))

 const serverInterface: ServerInterface = {
 url: undefined as unknown as URL,
 publish: (topic, data) => {
 this.publish(topic, data)
 },
 pendingWebSockets: this.wss.clients.size,
 }
 Object.defineProperty(serverInterface, 'url', {
 get: () => {
 if (!this._url) throw new Error('Server has not finished starting yet')
 return this._url
 },
 enumerable: true,
 })
 this.server = serverInterface

 this.wss.on('connection', () => {
 serverInterface.pendingWebSockets = this.wss.clients.size
 })
 this.wss.on('close', () => {
 serverInterface.pendingWebSockets = this.wss.clients.size
 })

 this.stack.adopt(this.httpServer, (srv) => srv.close())
 this.stack.adopt(this.wss, (srv) => srv.close())
 }

 public static async createServer(): Promise<PTYServer> {
 const staticRoutes = await buildStaticRoutes()
 const srv = new PTYServer(staticRoutes)
 const port = parseInt(process.env.PTY_WEB_PORT ?? '0',10)
 const hostname = process.env.PTY_WEB_HOSTNAME ?? '::1'
 await srv.start(port, hostname)
 return srv
 }

 private async start(port: number, hostname: string): Promise<void> {
 return new Promise((resolve, reject) => {
 const onError = (err: Error) => {
 this.httpServer.removeListener('listening', onListening)
 reject(err)
 }
 const onListening = () => {
 this.httpServer.removeListener('error', onError)
 const addr = this.httpServer.address()
 if (!addr || typeof addr === 'string') {
 reject(new Error('Failed to obtain server address after listen'))
 return
 }
 const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address
 this._url = new URL(`http://${host}:${addr.port}/`)
 resolve()
 }
 this.httpServer.once('error', onError)
 this.httpServer.once('listening', onListening)
 this.httpServer.listen(port, hostname)
 })
 }

 publish(topic: string, data: string): number {
 const subs = this.topics.get(topic)
 if (!subs) return 0
 let count =0
 for (const ws of subs) {
 if (ws.readyState === WebSocket.OPEN) {
 ws.send(data)
 count++
 }
 }
 return count
 }

 [Symbol.dispose]() {
 this.stack.dispose()
 }

 public getWsUrl(): string {
 return `${this.server.url.origin.replace(/^http/, 'ws')}${routes.websocket.path}`
 }

 // ----- HTTP dispatch -----

 private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
 const host = headerValue(req.headers.host)
 const url = new URL(req.url ?? '/', `http://${host || 'localhost'}`)
 const path = url.pathname
 const method = req.method ?? 'GET'
 const response = await this.dispatch(method, path, req)
 this.sendResponse(res, response)
 }

 private async dispatch(method: string, path: string, req: IncomingMessage): Promise<Response> {
 // Static assets
 if (method === 'GET') {
 const asset = this.staticRoutes.get(path)
 if (asset) {
 return new Response(asset.body as unknown as BodyInit, {
 status:200,
 headers: {
 'Content-Type': asset.contentType,
 'Cache-Control': 'public, max-age=31536000, immutable',
 ...SECURITY_HEADERS,
 },
 })
 }
 }

 // Health
 if (method === 'GET' && path === routes.health.path) {
 return handleHealth(this.server)
 }

 // WebSocket endpoint (handled by handleUpgrade; this branch is for plain GET)
 if (method === 'GET' && path === routes.websocket.path) {
 return new Response('WebSocket endpoint - use WebSocket upgrade', { status:426 })
 }

 // Sessions collection
 if (path === routes.sessions.path) {
 if (method === 'GET') return getSessions()
 if (method === 'POST') return createSession(await this.toBunRequest(req, {}))
 if (method === 'DELETE') return clearSessions()
 }

 // Session sub-routes (must match `/api/sessions/:id[/...]`)
 const idMatch = this.matchPath(path, routes.session.path)
 if (idMatch) {
 const nodeReq = await this.toBunRequest(req, idMatch as { id: string })
 if (method === 'GET') return getSession(nodeReq)
 if (method === 'DELETE') return killSession(nodeReq)
 }

 const cleanupMatch = this.matchPath(path, routes.session.cleanup.path)
 if (cleanupMatch && method === 'DELETE') {
 return cleanupSession(await this.toBunRequest(req, cleanupMatch as { id: string }))
 }

 const inputMatch = this.matchPath(path, routes.session.input.path)
 if (inputMatch && method === 'POST') {
 return sendInput(await this.toBunRequest(req, inputMatch as { id: string }))
 }

 const rawBufferMatch = this.matchPath(path, routes.session.buffer.raw.path)
 if (rawBufferMatch && method === 'GET') {
 return getRawBuffer(await this.toBunRequest(req, rawBufferMatch as { id: string }))
 }

 const plainBufferMatch = this.matchPath(path, routes.session.buffer.plain.path)
 if (plainBufferMatch && method === 'GET') {
 return getPlainBuffer(await this.toBunRequest(req, plainBufferMatch as { id: string }))
 }

 // SPA fallback: serve index.html for any unknown GET
 if (method === 'GET') {
 const indexHtml = this.staticRoutes.get('/index.html')
 if (indexHtml) {
 return new Response(indexHtml.body as unknown as BodyInit, {
 status:200,
 headers: {
 'Content-Type': indexHtml.contentType,
 ...SECURITY_HEADERS,
 },
 })
 }
 }

 return new Response('Not Found', { status:404 })
 }

 private matchPath(path: string, pattern: string): Record<string, string> | null {
 const pathParts = path.split('/').filter(Boolean)
 const patternParts = pattern.split('/').filter(Boolean)
 if (pathParts.length !== patternParts.length) return null
 const params: Record<string, string> = {}
 for (let i =0; i < patternParts.length; i++) {
 const patternPart = patternParts[i]
 const pathPart = pathParts[i]
 if (patternPart === undefined || pathPart === undefined) return null
 if (patternPart.startsWith(':')) {
 params[patternPart.slice(1)] = decodeURIComponent(pathPart)
 } else if (patternPart !== pathPart) {
 return null
 }
 }
 return params
 }

 private async toBunRequest<P extends Record<string, string>>(
 req: IncomingMessage,
 params: P
 ): Promise<NodeBunRequest<P>> {
 const chunks: Buffer[] = []
 for await (const chunk of req) {
 chunks.push(chunk as Buffer)
 }
 const rawBody = Buffer.concat(chunks).toString('utf8')
 const nodeReq = req as NodeBunRequest<P>
 nodeReq.params = params
 nodeReq.json = () => Promise.resolve(rawBody ? JSON.parse(rawBody) : undefined)
 return nodeReq
 }

 private sendResponse(res: ServerResponse, response: Response): void {
 res.statusCode = response.status
 response.headers.forEach((value, key) => {
 res.setHeader(key, value)
 })
 if (!response.body) {
 res.end()
 return
 }
 const reader = response.body.getReader()
 const pump = async () => {
 while (true) {
 const { done, value } = await reader.read()
 if (done) {
 res.end()
 return
 }
 res.write(Buffer.from(value))
 }
 }
 pump().catch((err) => {
 console.error('Response stream error:', err)
 res.end()
 })
 }

 // ----- WebSocket -----

 private handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
 const host = headerValue(req.headers.host)
 const url = new URL(req.url ?? '/', `http://${host || 'localhost'}`)
 if (url.pathname !== routes.websocket.path) {
 socket.destroy()
 return
 }
 if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
 socket.write('HTTP/1.1426 Upgrade Required\r\n\r\n')
 socket.destroy()
 return
 }
 this.wss.handleUpgrade(req, socket as Duplex, head, (ws) => {
 this.wss.emit('connection', ws, req)
 })
 }

 private onWsConnection(ws: SubscriberWebSocket): void {
 ws.subscriptions = new Set()

 ws.subscribe = (topic: string) => {
 let subs = this.topics.get(topic)
 if (!subs) {
 subs = new Set()
 this.topics.set(topic, subs)
 }
 subs.add(ws)
 ws.subscriptions.add(topic)
 }

 ws.unsubscribe = (topic: string) => {
 const subs = this.topics.get(topic)
 if (subs) {
 subs.delete(ws)
 if (subs.size ===0) this.topics.delete(topic)
 }
 ws.subscriptions.delete(topic)
 }

 ws.on('close', () => {
 for (const topic of ws.subscriptions) {
 const subs = this.topics.get(topic)
 if (subs) {
 subs.delete(ws)
 if (subs.size ===0) this.topics.delete(topic)
 }
 }
 })

 // Mirror Bun's open handler
 ws.subscribe('sessions:update')

 ws.on('message', (data) => {
 handleWebSocketMessage(ws, data as Buffer)
 })
 }
}
