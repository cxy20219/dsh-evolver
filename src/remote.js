/**
 * The browser-facing API of 自衍中枢 — thin entry.
 *
 * The endpoint table and its domain modules live in `src/remote/`; this file
 * stays the stable import path (`ENDPOINTS` and `createZiyanHandler`) so the
 * host and the tests do not depend on the internal layout.
 */

export { MAX_PREVIEW_BYTES, MAX_UPLOAD_BYTES } from './remote/files.js'
export { createZiyanHandler, ENDPOINTS } from './remote/index.js'
