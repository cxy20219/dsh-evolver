/**
 * An MCP server for the library verbs, so another agent can use them.
 *
 * The plugin already exposes four verbs to its own model. This module hands the
 * same four to any other MCP client — another DSH instance, Claude Code, a
 * desktop client — over the protocol DSH's own client speaks
 * (`transport: streamable-http`, endpoint `/mcp`). Reusing the tool objects
 * means one contract and one implementation: whatever the local model can do
 * to the library, the remote agent does the same way, and their error text is
 * the plugin's own.
 *
 * Two decisions shape the rest:
 *
 * - **Library only.** An MCP call carries no session: there is no working
 *   directory to anchor a project path against, so `harness/...` targets and
 *   arbitrary project files are refused by the tool layer itself with its own
 *   message. Handing out a guessed cwd would let a remote agent write into
 *   whatever directory it imagined it was in.
 * - **A bearer token, always.** The write verbs reach the library, so the
 *   endpoint is not public even though it binds to loopback: a token is minted
 *   on first start and checked on every request. Only `127.0.0.1` is bound —
 *   binding elsewhere is not offered at all.
 *
 * The protocol implemented here is the stateless subset: one JSON-RPC message
 * per POST, a JSON reply, no server-initiated stream. `GET /mcp` answers 405,
 * which the specification allows precisely because it means "no stream offered".
 */

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

import { sanitize } from '../json.js'
import { estimateTokens } from '../tokens.js'

/** The MCP protocol revisions this server knows about, newest first. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

/** The path the endpoint lives on. */
export const MCP_PATH = '/mcp'

/** Bounds for the listening port. */
export const PORT_MIN = 1024
export const PORT_MAX = 65535
export const PORT_DEFAULT = 3199

/** The largest request body a JSON-RPC message may carry. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** JSON-RPC and MCP error codes used below. */
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

/**
 * Mint a token for the endpoint.
 *
 * @returns {string} 32 bytes, base64url — long enough that guessing is not a
 * thing, short enough to paste into a config file.
 */
export function mintToken() {
	return randomBytes(24).toString('base64url')
}

/**
 * The endpoint URL a client should be configured with.
 *
 * @param {number} port - The listening port.
 * @param {string} token - The bearer token, or an empty string.
 * @returns {string} The URL.
 */
export function endpointUrl(port, token) {
	return `http://127.0.0.1:${port}${MCP_PATH}${token === '' ? '' : `?token=${encodeURIComponent(token)}`}`
}

/**
 * Compare two secrets without leaking length or content through timing.
 *
 * @param {string} left - What arrived.
 * @param {string} right - What was expected.
 * @returns {boolean} True when they match.
 */
function timingSafeEqual(left, right) {
	if (left.length !== right.length) return false
	let diff = 0
	for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index)
	return diff === 0
}

/**
 * Whether a request carries the token, as a header or a query parameter.
 *
 * Both are accepted because MCP clients differ: some send `Authorization`,
 * some cannot set headers at all and only take a URL. The URL form is what the
 * panel copies, so a client that cannot set headers still works.
 *
 * @param {import('node:http').IncomingMessage} request - The request.
 * @param {string} token - The expected token.
 * @returns {boolean} True when the request may proceed.
 */
export function authorized(request, token) {
	if (token === '') return true
	const header = String(request.headers.authorization ?? '')
	const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
	if (bearer !== '' && timingSafeEqual(bearer, token)) return true
	let query = ''
	try {
		query = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('token') ?? ''
	} catch {
		query = ''
	}
	return query !== '' && timingSafeEqual(query, token)
}

/**
 * Read one request body as UTF-8, refusing anything oversized.
 *
 * @param {import('node:http').IncomingMessage} request - The request.
 * @returns {Promise<string>} The body.
 */
function readBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let size = 0
		request.on('data', (chunk) => {
			size += chunk.length
			if (size > MAX_BODY_BYTES) {
				reject(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节。`))
				request.destroy()
				return
			}
			chunks.push(chunk)
		})
		request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
		request.on('error', reject)
	})
}

/**
 * Build one JSON-RPC error reply.
 *
 * @param {number} code - The JSON-RPC code.
 * @param {string} message - The message.
 * @param {unknown} [id] - The request id, echoed back.
 * @returns {object} The reply.
 */
function rpcError(code, message, id = null) {
	return { jsonrpc: '2.0', id, error: { code, message } }
}

/**
 * Pick the protocol revision to answer with.
 *
 * The client proposes one; answering with its own proposal is what lets a
 * client newer than this file keep talking. An unknown or absent value falls
 * back to the newest revision implemented here.
 *
 * @param {unknown} requested - The client's `protocolVersion`.
 * @returns {string} The revision to state.
 */
export function negotiateVersion(requested) {
	const text = typeof requested === 'string' ? requested.trim() : ''
	return text !== '' ? text : PROTOCOL_VERSIONS[0]
}

/**
 * The tool catalog an MCP client sees.
 *
 * Descriptions and schemas come straight from the live tool objects, so the
 * remote agent reads the same text the local model does — including the
 * target × capability contract that says a `harness/` path needs a session.
 *
 * @param {object[]} tools - The tool objects from `createTools`.
 * @returns {object[]} MCP tool definitions.
 */
export function toolCatalog(tools) {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters,
		annotations: {
			title: tool.name,
			// The library verbs read and write; MCP clients use these hints for
			// confirmation prompts, so an honest answer matters more than a pretty one.
			readOnlyHint: tool.name === 'file_search' || tool.name === 'file_read',
		},
	}))
}

/**
 * Run one tool call and shape the MCP result.
 *
 * A thrown error becomes `isError` content rather than a protocol error: the
 * model on the other side should read the plugin's message ("路径越界…",
 * "无法确定当前会话工作目录…") and correct itself, exactly as the local model
 * would. A protocol error would hide the reason behind a transport failure.
 *
 * @param {object[]} tools - The tool objects.
 * @param {string} name - The tool name.
 * @param {object} args - The arguments.
 * @returns {Promise<object>} The MCP result.
 */
async function callTool(tools, name, args) {
	const tool = tools.find((item) => item.name === name)
	if (tool === undefined) {
		return { content: [{ type: 'text', text: `没有这个工具：${name}` }], isError: true }
	}
	try {
		// No `paths`: the library verbs work, and every project-path verb refuses
		// with the plugin's own "需要会话工作目录" message.
		const value = await tool.execute(args, {})
		// Same wire shape the local model sees: the result object as pretty JSON.
		const text = JSON.stringify(sanitize(value), null, 2)
		return { content: [{ type: 'text', text }] }
	} catch (error) {
		return {
			content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
			isError: true,
		}
	}
}

/**
 * Answer one JSON-RPC message.
 *
 * @param {object[]} tools - The tool objects.
 * @param {object} message - The parsed JSON-RPC message.
 * @param {{name: string, version: string}} serverInfo - What to call ourselves.
 * @returns {Promise<object | undefined>} The reply, or undefined for a notification.
 */
export async function dispatch(tools, message, serverInfo) {
	if (message === null || typeof message !== 'object' || Array.isArray(message)) {
		return rpcError(INVALID_REQUEST, 'JSON-RPC 消息必须是对象。')
	}
	const id = message.id === undefined ? null : message.id
	const method = typeof message.method === 'string' ? message.method : ''
	if (message.jsonrpc !== '2.0' || method === '') {
		return rpcError(INVALID_REQUEST, '不是合法的 JSON-RPC 2.0 请求。', id)
	}
	// A notification has no id and gets no reply at all. `initialized` is the one
	// every client sends, and answering it breaks the handshake.
	if (message.id === undefined) return undefined

	const params = message.params !== null && typeof message.params === 'object' ? message.params : {}
	if (method === 'initialize') {
		return {
			jsonrpc: '2.0',
			id,
			result: {
				protocolVersion: negotiateVersion(params.protocolVersion),
				capabilities: { tools: { listChanged: false } },
				serverInfo,
				instructions: '自衍中枢文件库：先 file_search 按描述/标签检索，再 file_read 取正文；file_write 新建或整篇改写，file_edit 用 old+new 改一段。项目路径（harness/…）需要会话工作目录，经 MCP 调用不可用，只支持库文件。',
			},
		}
	}
	if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
	if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: toolCatalog(tools) } }
	if (method === 'tools/call') {
		const name = typeof params.name === 'string' ? params.name : ''
		if (name === '') return rpcError(INVALID_PARAMS, 'tools/call 需要 name。', id)
		const args = params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {}
		return { jsonrpc: '2.0', id, result: await callTool(tools, name, args) }
	}
	return rpcError(METHOD_NOT_FOUND, `不支持的方法：${method}`, id)
}

/**
 * Create the MCP service.
 *
 * `start` is idempotent and `stop` closes the listener; both are safe to call
 * from the settings-save path, which is the only caller. Nothing is started
 * until `start` runs: the switch is off by default and an untouched install
 * opens no port.
 *
 * @param {{tools: object[], log?: object, serverInfo: {name: string, version: string}}} options - The wiring.
 * @returns {object} The service.
 */
export function createMcpService({ tools, log, serverInfo }) {
	let server = null
	let port = PORT_DEFAULT
	let token = ''
	let lastError = ''

	/**
	 * The state the panel shows.
	 *
	 * @returns {{running: boolean, port: number, token: string, url: string, tools: string[], problem: string, tokens: number}} The status.
	 */
	function status() {
		return {
			running: server !== null,
			port,
			token,
			url: server === null ? '' : endpointUrl(port, token),
			tools: tools.map((tool) => tool.name),
			// Deliberately not `error`: the panel treats any `error` member as a
			// failed call envelope, so a field named that would make every status
			// read look like a failure.
			problem: server === null ? lastError : '',
			tokens: estimateTokens(tools.map((tool) => `${tool.name} ${tool.description}`).join('\n')),
		}
	}

	/**
	 * Stop listening, if listening.
	 *
	 * @returns {Promise<void>} Resolved once the port is free.
	 */
	async function stop() {
		const closing = server
		if (closing === null) return
		server = null
		await new Promise((resolve) => closing.close(() => resolve()))
		log?.info?.('自衍中枢：MCP 服务已停止')
	}

	/**
	 * Answer one HTTP request.
	 *
	 * @param {import('node:http').IncomingMessage} request - The request.
	 * @param {import('node:http').ServerResponse} response - The response.
	 * @returns {Promise<void>} Resolved when the reply is written.
	 */
	async function handle(request, response) {
		const path = (request.url ?? '/').split('?')[0]
		if (path !== MCP_PATH) {
			response.writeHead(404, { 'content-type': 'application/json' })
			response.end(JSON.stringify({ error: 'not found' }))
			return
		}
		if (!authorized(request, token)) {
			// 401 with the scheme hint, so a client sends the header next time.
			response.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
			response.end(JSON.stringify(rpcError(INVALID_REQUEST, '缺少或错误的 MCP 令牌。')))
			return
		}
		if (request.method === 'GET') {
			// No server-initiated stream: the spec allows 405 for exactly this.
			response.writeHead(405, { 'content-type': 'application/json', allow: 'POST, DELETE' })
			response.end(JSON.stringify(rpcError(INVALID_REQUEST, '本服务不提供服务端推送流，请用 POST。')))
			return
		}
		if (request.method === 'DELETE') {
			response.writeHead(204)
			response.end()
			return
		}
		if (request.method !== 'POST') {
			response.writeHead(405, { 'content-type': 'application/json', allow: 'POST, DELETE' })
			response.end(JSON.stringify(rpcError(INVALID_REQUEST, '只接受 POST。')))
			return
		}
		let text = ''
		try {
			text = await readBody(request)
		} catch (failure) {
			response.writeHead(413, { 'content-type': 'application/json' })
			response.end(JSON.stringify(rpcError(INVALID_REQUEST, failure.message)))
			return
		}
		let message
		try {
			message = JSON.parse(text)
		} catch {
			response.writeHead(400, { 'content-type': 'application/json' })
			response.end(JSON.stringify(rpcError(PARSE_ERROR, '请求体不是合法 JSON。')))
			return
		}
		const reply = await dispatch(tools, message, serverInfo)
		if (reply === undefined) {
			// A notification is acknowledged without a body.
			response.writeHead(202)
			response.end()
			return
		}
		response.writeHead(200, { 'content-type': 'application/json' })
		response.end(JSON.stringify(reply))
	}

	/**
	 * Start listening, if not already.
	 *
	 * @param {{port: number, token: string}} options - Where and how.
	 * @returns {Promise<object>} The status after the attempt.
	 */
	async function start({ port: wantedPort, token: wantedToken }) {
		port = wantedPort
		token = wantedToken
		if (server !== null) return status()
		lastError = ''
		const created = createServer((request, response) => {
			handle(request, response).catch((failure) => {
				lastError = failure instanceof Error ? failure.message : String(failure)
				if (!response.headersSent) {
					response.writeHead(500, { 'content-type': 'application/json' })
					response.end(JSON.stringify(rpcError(INTERNAL_ERROR, lastError)))
				}
			})
		})
		try {
			await new Promise((resolve, reject) => {
				const onError = (failure) => reject(failure)
				created.once('error', onError)
				created.listen(port, '127.0.0.1', () => {
					created.removeListener('error', onError)
					resolve()
				})
			})
		} catch (failure) {
			lastError = failure instanceof Error ? failure.message : String(failure)
			log?.warn?.(`自衍中枢：MCP 服务启动失败：${lastError}`)
			return status()
		}
		server = created
		// A caller may ask for port 0 (tests) and the OS assigns one; report what
		// is actually listening, not what was requested.
		const actual = created.address()
		if (actual !== null && typeof actual === 'object') port = actual.port
		log?.info?.(`自衍中枢：MCP 服务已启动 http://127.0.0.1:${port}${MCP_PATH}（${tools.length} 个工具）`)
		return status()
	}

	return { start, stop, status }
}
