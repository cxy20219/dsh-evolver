/**
 * The standalone host: 自衍中枢 without DSH.
 *
 * Everything the panel needs already exists and knows nothing about the plugin
 * host — `FileStore` takes a data directory, `createZiyanHandler` takes an
 * endpoint name and a payload, and `client.js` asks for `/api/ziyan/<name>`.
 * This file is the assembly that DSH used to do: open the store, wire the
 * satellites, and serve both the JSON API and the browser half over HTTP.
 *
 * What is deliberately absent: the organizer (it needs an LLM the host does not
 * have yet), the system-prompt section (nothing to inject into), and the tool
 * registration (this process is not an agent). The MCP endpoint stays available
 * because other agents are exactly who a standalone library should serve.
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDataJobs } from '../src/data-jobs.js'
import { createLogSink } from '../src/logs.js'
import { createMcpService, mintToken } from '../src/mcp/server.js'
import { createZiyanHandler } from '../src/remote.js'
import { SettingsStore } from '../src/settings.js'
import { FileStore } from '../src/store.js'
import { createTools } from '../src/tools.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

/** Where the library lives when nothing says otherwise. */
export const DEFAULT_DATA_DIR = join(homedir(), '.ziyan')

/** The port the local service binds by default (MCP uses 3199). */
export const DEFAULT_PORT = 3198

/** Where the service binds: loopback only, like the MCP endpoint. */
const HOST = '127.0.0.1'

/** The largest request body the panel API parses. */
const MAX_REQUEST_BYTES = 48 * 1024 * 1024

/** Content types for the handful of files the browser half loads. */
const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
}

/**
 * Read the plugin version, tolerating a missing or malformed package file.
 *
 * @returns {Promise<string>} The version, or an empty string.
 */
async function readVersion() {
	try {
		const text = await readFile(join(REPO, 'package.json'), 'utf8')
		return typeof JSON.parse(text)?.version === 'string' ? JSON.parse(text).version : ''
	} catch {
		return ''
	}
}

/**
 * Read a request body, refusing anything the panel would not send.
 *
 * @param {import('node:http').IncomingMessage} request - The request.
 * @returns {Promise<Buffer>} The body.
 */
async function readBody(request) {
	const chunks = []
	let total = 0
	for await (const chunk of request) {
		total += chunk.length
		if (total > MAX_REQUEST_BYTES) throw new Error(`请求体超过 ${MAX_REQUEST_BYTES} 字节上限。`)
		chunks.push(chunk)
	}
	return Buffer.concat(chunks)
}

/**
 * Serve one file from disk, refusing anything outside its root.
 *
 * @param {import('node:http').ServerResponse} response - The response.
 * @param {string} root - The directory the file must stay inside.
 * @param {string} relativePath - The requested path.
 * @returns {Promise<boolean>} Whether a file was served.
 */
async function serveFile(response, root, relativePath) {
	const clean = normalize(relativePath).replace(/^([/\\])+/, '')
	const absolute = resolve(root, clean)
	if (absolute !== root && !absolute.startsWith(root + '/')) {
		response.writeHead(403).end('forbidden')
		return true
	}
	const data = await readFile(absolute).catch(() => undefined)
	if (data === undefined) return false
	response.writeHead(200, {
		'content-type': MIME[extname(absolute)] ?? 'application/octet-stream',
		'cache-control': 'no-cache',
	})
	response.end(data)
	return true
}

/**
 * Open the library and start serving it.
 *
 * @param {{dataDir?: string, port?: number, onLog?: (line: string) => void}} [options] - Start-up options.
 * @returns {Promise<{url: string, port: number, store: object, settings: object, mcp: object, close: () => Promise<void>}>} The running service.
 */
export async function startService({ dataDir, port = DEFAULT_PORT, onLog } = {}) {
	const configured = typeof dataDir === 'string' ? dataDir.trim() : ''
	if (configured !== '' && !isAbsolute(configured)) throw new Error('dataDir 必须是绝对路径。')
	const root = configured === '' ? DEFAULT_DATA_DIR : resolve(configured)

	const systemDir = join(root, 'system')
	const logs = createLogSink({ dataDir: systemDir, forward: onLog === undefined ? undefined : { info: onLog, warn: onLog, error: onLog } })
	const settings = new SettingsStore({ dataDir: root, logger: logs })
	await settings.load()
	const current = settings.get()

	const store = new FileStore({
		dataDir: root,
		logger: logs,
		maxBytes: current.maxFileBytes,
		readTextBytes: current.readTextBytes,
		descriptionMaxChars: current.descriptionMaxChars,
	})
	await store.open()

	const version = await readVersion()
	// The pointer file is how a host remembers "the library moved here". DSH
	// keeps it under its own home; standalone it sits beside the library, so a
	// moved library still knows where it went.
	const data = createDataJobs({ root, pointerPath: join(root, 'system', 'library.json'), settings, logger: logs, version })
	const tools = createTools({ store, paths: async () => ({}) })

	// The MCP endpoint is the standalone library's reason to exist for agents;
	// it starts when the settings say so, exactly as in the plugin.
	const mcp = createMcpService({ tools, log: logs, serverInfo: { name: 'ziyan', version } })
	if (current.mcp.token === '') await settings.save({ mcp: { token: mintToken() } })
	if (current.mcp.enabled) await mcp.start({ port: current.mcp.port, token: settings.get().mcp.token })

	const handler = createZiyanHandler({
		store,
		settings,
		logs,
		root,
		version,
		data,
		tools,
		mcp,
	})

	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? '/', `http://${request.headers.host ?? HOST}`)
			const path = url.pathname

			if (path.startsWith('/api/ziyan/')) {
				const endpoint = path.slice('/api/ziyan/'.length)
				const body = await readBody(request)
				let payload = {}
				if (body.length > 0) {
					try {
						payload = JSON.parse(body.toString('utf8'))
					} catch {
						response.writeHead(400, { 'content-type': MIME['.json'] })
						response.end(JSON.stringify({ error: { message: '请求体不是合法 JSON。' } }))
						return
					}
				}
				try {
					const result = await handler(endpoint, payload)
					response.writeHead(200, { 'content-type': MIME['.json'] })
					response.end(JSON.stringify(result ?? {}))
				} catch (error) {
					response.writeHead(400, { 'content-type': MIME['.json'] })
					response.end(JSON.stringify({ error: { message: String(error?.message ?? error) } }))
				}
				return
			}

			// The browser half: the panel lives in the repository root, the shim
			// and the React bundles beside this file.
			if (path === '/client.js') {
				if (await serveFile(response, REPO, 'client.js')) return
			}
			if (path === '/icon.svg') {
				if (await serveFile(response, REPO, 'icon.svg')) return
			}
			if (path === '/' || path === '/index.html') {
				if (await serveFile(response, join(HERE, 'renderer'), 'index.html')) return
			}
			if (await serveFile(response, join(HERE, 'renderer'), path.slice(1))) return

			response.writeHead(404).end('not found')
		} catch (error) {
			response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
			response.end(`内部错误：${String(error?.message ?? error)}`)
		}
	})

	await new Promise((resolve_, reject) => {
		server.once('error', reject)
		server.listen(port, HOST, () => {
			server.off('error', reject)
			resolve_()
		})
	})
	const actualPort = server.address().port
	const url = `http://${HOST}:${actualPort}`

	return {
		url,
		port: actualPort,
		root,
		store,
		settings,
		mcp,
		close: async () => {
			await mcp.stop().catch(() => {})
			await new Promise((done) => server.close(() => done()))
			store.close()
		},
	}
}

// Run directly: `node desktop/server.js [--data-dir DIR] [--port N]`
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2)
	const flag = (name) => {
		const index = args.indexOf(`--${name}`)
		return index === -1 ? undefined : args[index + 1]
	}
	const service = await startService({
		dataDir: flag('data-dir'),
		port: flag('port') === undefined ? DEFAULT_PORT : Number(flag('port')),
		onLog: (line) => console.log(line),
	})
	console.log(`自衍中枢已启动：${service.url}`)
	console.log(`数据目录：${service.root}`)
}
