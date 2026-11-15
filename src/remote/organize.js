/**
 * The organize endpoints: the unattended cleanup engine and the digest of the
 * host's sessions.
 *
 * The organize engine is optional at the transport level. A host mounted
 * without it still answers `organize-status` with a readable refusal rather
 * than crashing the plugin, so every handler goes through `organizer()`.
 */

import { join } from 'node:path'

import { listSessions } from '../sessions.js'
import { dshHome } from './support.js'

/**
 * Where the host keeps its session logs.
 *
 * The store's own data folder sits inside the same home, but the sessions are
 * the host's, not the library's: this is the one place the plugin reads outside
 * its data directory, and it only ever reads summaries.
 *
 * @returns {string} The absolute path.
 */
function sessionsRoot() {
	return join(dshHome(), 'sessions')
}

/** The endpoints this module owns. */
export const organizeHandlers = {
	digest: async () => {
		// The organize tab only lists recent sessions. The old issue
		// report lives inside the organize job now, and the payload
		// fields that used to tune it were never sent by the panel.
		const listing = await listSessions({ root: sessionsRoot() })
		return { sessions: listing.sessions, sessionTotal: listing.total }
	},

	'organize-status': async (_payload, { organizer }) => organizer().status(),

	'organize-save': async (payload, { organizer }) => organizer().save(payload ?? {}),

	'organize-start': async (payload, { organizer }) => organizer().start(payload ?? {}),

	'organize-jobs': async (payload, { organizer }) => organizer().jobs(payload ?? {}),

	'organize-cancel': async (payload, { organizer }) => organizer().cancel(payload ?? {}),
}
