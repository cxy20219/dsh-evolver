/**
 * The browser-facing API of 自衍中枢: assembly and dispatch.
 *
 * One authenticated prefix (`/api/ziyan`) owns every endpoint the panel
 * calls. The handler takes plain JSON and returns plain JSON; the route layer
 * in `index.js` turns a thrown error into `{error:{...}}` with HTTP 400.
 *
 * The endpoints are a table, not a switch: each domain module exports a
 * `Record<endpoint, handler>` and `ENDPOINTS` is derived from the merged
 * table. Adding an endpoint therefore touches the table and the client, never
 * a second list that can drift.
 */

import { describeTools } from '../tools.js'
import { dataHandlers } from './data.js'
import { filesHandlers } from './files.js'
import { organizeHandlers } from './organize.js'
import { panelHandlers } from './panel.js'

/**
 * The endpoint table: endpoint name → `(payload, deps) => Promise<any>`.
 *
 * `deps` is assembled once per registered handler in `createZiyanHandler`:
 * `{store, settings, logs, root, version, data, catalog, organizer}`.
 */
export const HANDLERS = Object.freeze({
	...filesHandlers,
	...panelHandlers,
	...organizeHandlers,
	...dataHandlers,
})

/** The endpoints the panel may call, derived from the handler table. */
export const ENDPOINTS = Object.keys(HANDLERS)

/**
 * Create the endpoint handler.
 *
 * @param {{store: object, settings: object, logs: object, root: string, version?: string, data?: object, tools?: object[], mcp?: object, organize?: object}} deps - The open store and its satellites; `tools` is what `createTools` returned, `mcp` the endpoint from `createMcpService`, `organize` the engine from `createOrganizer`.
 * @returns {(endpoint: string, payload: object) => Promise<any>} The handler.
 */
export function createZiyanHandler({ store, settings, logs, root, version = '', data, tools = [], mcp, organize }) {
	// Described once, at registration: the catalog is static for the life of
	// the host process, and a missing `tools` dep yields an empty catalog.
	const catalog = describeTools(tools)
	const deps = {
		store,
		settings,
		logs,
		root,
		version,
		data,
		catalog,
		/**
		 * The MCP endpoint, or a readable refusal when the host did not mount it.
		 *
		 * @returns {object} The service.
		 */
		mcp() {
			if (mcp === undefined) throw new Error('MCP 服务不可用：宿主装配没有提供 mcp 依赖。')
			return mcp
		},
		/**
		 * The organize engine, or a readable refusal on a host that mounted the
		 * plugin without the optional services it degrades from.
		 *
		 * @returns {object} The engine.
		 */
		organizer() {
			if (organize === undefined) throw new Error('整理引擎不可用：宿主装配没有提供 organize 依赖。')
			return organize
		},
	}

	return async function handleZiyan(endpoint, payload = {}) {
		const handler = HANDLERS[endpoint]
		if (handler === undefined) throw new Error(`未知接口：${String(endpoint)}`)
		return handler(payload, deps)
	}
}
