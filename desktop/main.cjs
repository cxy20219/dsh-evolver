/**
 * The desktop shell: one window, one local service, no cloud.
 *
 * The main process owns the service (the same HTTP server `desktop/server.js`
 * exposes for headless use) and the window simply points at it. Nothing about
 * the library is reimplemented here — this file decides where the window goes
 * and what happens when it closes.
 *
 * CommonJS on purpose: Electron injects its built-in modules into `require`,
 * and that injection does not survive an ESM import of `electron`. The service
 * is ESM, so it is loaded with a dynamic `import()` where it is needed.
 *
 * Loopback only: the service binds 127.0.0.1, so the window and any agent on
 * the same machine reach it, and nothing outside does.
 */

const { app, BrowserWindow, Menu, nativeTheme, shell } = require('electron')

/** The library directory, or undefined when the user has not chosen one. */
let dataDir

/** The running service, or undefined before start-up finished. */
let service

/** The single window. */
let window

/**
 * Where the library lives for this launch.
 *
 * `--data-dir` wins so the app can be pointed at an existing library (and so a
 * test can run against a throwaway one); otherwise the service default applies.
 *
 * @returns {string | undefined} The directory override.
 */
function dataDirFromArgv() {
	const argv = process.argv.slice(1)
	const index = argv.findIndex((argument) => argument === '--data-dir')
	if (index !== -1 && typeof argv[index + 1] === 'string') return argv[index + 1]
	const inline = argv.find((argument) => argument.startsWith('--data-dir='))
	return inline === undefined ? undefined : inline.slice('--data-dir='.length)
}

/**
 * Create the window and load the panel from the local service.
 *
 * @param {string} url - The service URL.
 * @returns {Promise<void>} Resolves once the window is showing.
 */
async function createWindow(url) {
	window = new BrowserWindow({
		width: 1180,
		height: 820,
		minWidth: 880,
		minHeight: 560,
		title: '自衍中枢',
		titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
		// Matches the light theme's base; the page paints over it immediately.
		backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#ffffff',
		webPreferences: {
			// The panel is plain web code; it needs no Node access.
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
		},
	})

	// Links out of the panel open in the user's browser, never inside the app.
	window.webContents.setWindowOpenHandler(({ url: target }) => {
		shell.openExternal(target)
		return { action: 'deny' }
	})

	await window.loadURL(url)
	console.log(`窗口已打开：${url}（库 ${service.root}）`)
}

/**
 * Start the service, then the window.
 *
 * @returns {Promise<void>} Resolves when both are up.
 */
async function boot() {
	dataDir = dataDirFromArgv()
	const { startService } = await import('./server.js')
	service = await startService({ dataDir, onLog: (line) => console.log(line) })
	await createWindow(service.url)
}

/**
 * Show a start-up failure inside a window instead of a silent quit.
 *
 * @param {unknown} error - What went wrong.
 * @returns {Promise<void>} Resolves once the message is showing.
 */
async function showFailure(error) {
	const message = String(error?.stack ?? error)
	window = new BrowserWindow({ width: 760, height: 420, backgroundColor: '#0f1115' })
	await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(
		'<body style="font-family:-apple-system,sans-serif;background:#0f1115;color:#e6e8eb;padding:28px">'
		+ '<h2 style="color:#f85149">自衍中枢启动失败</h2>'
		+ `<pre style="white-space:pre-wrap;font-size:12px">${message.replace(/[<>&]/g, '')}</pre></body>`,
	)}`)
}

// One instance owns the library: a second launch focuses the first window
// instead of opening a second service on the same SQLite file.
if (!app.requestSingleInstanceLock()) {
	app.quit()
} else {
	app.on('second-instance', () => {
		if (window === undefined) return
		if (window.isMinimized()) window.restore()
		window.focus()
	})

	app.whenReady().then(async () => {
		// A minimal menu: this app is a library, not a document editor.
		if (process.platform === 'darwin') {
			Menu.setApplicationMenu(Menu.buildFromTemplate([
				{ role: 'appMenu' },
				{ role: 'editMenu' },
				{ role: 'viewMenu' },
				{ role: 'windowMenu' },
			]))
		}
		try {
			await boot()
		} catch (error) {
			await showFailure(error)
		}
	})

	app.on('window-all-closed', () => {
		if (process.platform !== 'darwin') app.quit()
	})

	app.on('before-quit', async () => {
		await service?.close().catch(() => {})
		service = undefined
	})
}
