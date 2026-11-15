/**
 * The data endpoints: the library's own folder, export and import.
 *
 * The data-jobs service owns the filesystem work; these handlers only normalise
 * the payload and reject an unknown data-directory mode before it reaches the
 * service.
 */

import { text } from './support.js'

/** The endpoints this module owns. */
export const dataHandlers = {
	'data-status': async (_payload, { data }) => data.status(),

	'data-dir-save': async (payload, { data }) => {
		const mode = text(payload, 'mode', 'copy')
		if (mode !== 'copy' && mode !== 'attach') throw new Error('数据目录模式只能是 copy 或 attach。')
		return data.saveDir({ dir: text(payload, 'dir'), mode })
	},

	'data-export': async (_payload, { data }) => data.exportLibrary(),

	'data-import': async (payload, { data }) => data.importLibrary({ data: text(payload, 'data'), dir: text(payload, 'dir') }),
}
