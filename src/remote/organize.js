/**
 * The organize endpoints: the unattended cleanup engine and the digest of the
 * host's sessions.
 *
 * The organize engine is optional at the transport level. A host mounted
 * without it still answers `organize-status` with a readable refusal rather
 * than crashing the plugin, so every handler goes through `organizer()`.
 */

import { join } from 'node:path'

import { FILES_SYSTEM, SESSION_SYSTEM, wrapUpInstruction } from '../organize/prompts.js'
import { listSessions } from '../sessions.js'
import { estimateTokens } from '../tokens.js'
import { dshHome } from './support.js'

/**
 * One static prompt of an organize run, with its estimated token size.
 *
 * The panel only reads this; the prompts themselves are built by the organizer
 * from the job and the library. Keeping the copy here means the page shows the
 * same text the model receives.
 *
 * @param {string} id - The stable section id the panel labels.
 * @param {string} text - The prompt text.
 * @returns {{id: string, text: string, tokens: number}} The section.
 */
function promptSection(id, text) {
	return { id, text, tokens: estimateTokens(text) }
}

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

	// The two system prompts are fixed; the wrap-up instruction depends only on
	// the dry-run flag. The per-job user message (transcript / library report)
	// is built when the job starts and is not part of this catalog.
	'organize-prompts': async () => ({
		sections: [
			promptSection('sessions', SESSION_SYSTEM),
			promptSection('files', FILES_SYSTEM),
			promptSection('wrapup', wrapUpInstruction({ dryRun: false })),
			promptSection('wrapup-dry', wrapUpInstruction({ dryRun: true })),
		],
	}),

	'organize-save': async (payload, { organizer }) => organizer().save(payload ?? {}),

	'organize-start': async (payload, { organizer }) => organizer().start(payload ?? {}),

	'organize-jobs': async (payload, { organizer }) => organizer().jobs(payload ?? {}),

	'organize-cancel': async (payload, { organizer }) => organizer().cancel(payload ?? {}),
}
