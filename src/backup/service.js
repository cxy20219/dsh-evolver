/**
 * Automatic OSS backups of the data folder.
 *
 * One snapshot is one tar object, so a remote folder stays readable: the keys
 * are `…/backup-<timestamp>.tar`, they sort by time, and retention is just
 * "keep the newest N". The service holds no timer state in the settings file
 * beyond the last run, so a restart simply catches up on the next heartbeat.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { OssClient } from './oss.js'
import { writeTarFile } from './archive.js'

/** How often the scheduler looks at the clock. */
const HEARTBEAT_MS = 60_000

/** How long after startup the first catch-up check runs. */
const STARTUP_DELAY_MS = 10_000

/**
 * Whether a key is one of this plugin's backup objects.
 *
 * Retention must never delete something the user happened to put under the
 * same prefix, so the decision is made on the exact key shape.
 *
 * @param {string} prefix - The configured prefix.
 * @param {string} key - The object key.
 * @returns {boolean} True when the key is a snapshot.
 */
export function isBackupKey(prefix, key) {
	const head = `${prefix}/backup-`
	if (!key.startsWith(head) || !key.endsWith('.tar')) return false
	// Seconds-precision keys are accepted too: an older snapshot must stay
	// eligible for retention.
	return /^\d{8}T\d{6}(?:\d{3})?Z$/.test(key.slice(head.length, -4))
}

/**
 * The timestamp used in an object key.
 *
 * The milliseconds are part of the key: two manual backups inside the same
 * second must not overwrite each other, and the string still sorts by time.
 *
 * @param {Date} date - The time.
 * @returns {string} `YYYYMMDDTHHmmssSSSZ`.
 */
export function keyStamp(date) {
	return date.toISOString().replace(/[-:]/g, '').replace(/[.]\d{3}Z$/, (match) => `${match.slice(1, 4)}Z`)
}

/**
 * The backup service.
 */
export class BackupService {
	/**
	 * @param {object} deps - Dependencies.
	 * @param {object} deps.settings - The settings store.
	 * @param {() => string} deps.root - The current data folder.
	 * @param {object} [deps.logger] - Logger.
	 * @param {() => object} [deps.client] - Client factory, injectable for tests.
	 * @param {() => Date} [deps.now] - Clock, injectable for tests.
	 * @param {number} [deps.heartbeatMs] - Heartbeat interval.
	 */
	constructor({ settings, root, logger, client, now = () => new Date(), heartbeatMs = HEARTBEAT_MS }) {
		this.settings = settings
		this.root = typeof root === 'function' ? root : () => root
		this.logger = logger
		this.clientFactory = typeof client === 'function' ? client : undefined
		this.now = now
		this.heartbeatMs = heartbeatMs
		this.timer = undefined
		this.startup = undefined
		this.running = false
	}

	/**
	 * The OSS client for the current configuration.
	 *
	 * @returns {OssClient} The client.
	 */
	client() {
		if (this.clientFactory !== undefined) return this.clientFactory()
		const config = this.settings.get().backup
		return new OssClient({
			endpoint: config.endpoint,
			bucket: config.bucket,
			accessKeyId: config.accessKeyId,
			accessKeySecret: config.accessKeySecret,
		})
	}

	/**
	 * Whether the configuration has everything a backup needs.
	 *
	 * @returns {{ready: boolean, missing: string[]}} The verdict.
	 */
	readiness() {
		const config = this.settings.get().backup
		const missing = []
		if (config.endpoint === '') missing.push('endpoint')
		if (config.bucket === '') missing.push('bucket')
		if (config.accessKeyId === '') missing.push('accessKeyId')
		if (config.accessKeySecret === '') missing.push('accessKeySecret')
		return { ready: missing.length === 0, missing }
	}

	/**
	 * Take one snapshot and apply the retention rule.
	 *
	 * @param {{force?: boolean, reason?: string}} [options] - Run options.
	 * @returns {Promise<object>} What happened.
	 */
	async runNow({ force = false, reason = 'manual' } = {}) {
		if (this.running) throw new Error('备份正在进行中，请稍后再试。')
		const config = this.settings.get().backup
		if (!config.enabled && !force) throw new Error('自动备份未启用，先打开开关并保存。')
		const readiness = this.readiness()
		if (!readiness.ready) throw new Error(`云端备份配置不完整：缺少 ${readiness.missing.join('、')}。`)
		const startedAt = this.now()
		// Everything below runs inside the try: a failed settings write used to
		// leave `running` set forever, and every later backup was refused with
		// "already running" until the Host restarted.
		const directory = await mkdtemp(join(tmpdir(), 'dsh-evolver-backup-'))
		const tarPath = join(directory, 'snapshot.tar')
		this.running = true
		try {
			await this.settings.updateStatus({ lastAttemptAt: startedAt.toISOString() })
			// Weights live in the data folder now, so a snapshot can be
			// hundreds of megabytes: write the tar to disk and upload the file
			// instead of holding the whole archive in memory.
			const packed = await writeTarFile(this.root(), tarPath)
			const key = `${config.prefix}/backup-${keyStamp(startedAt)}.tar`
			const client = this.client()
			if (typeof client.putObjectFromFile === 'function') {
				await client.putObjectFromFile(key, tarPath, { size: packed.bytes, contentMd5: packed.contentMd5 })
			} else {
				await client.putObject(key, await readFile(tarPath), 'application/x-tar')
			}
			// The snapshot exists now. Record it before retention: a failing
			// delete must not make the next heartbeat upload another copy of
			// the same data while the old objects linger.
			await this.settings.updateStatus({
				lastBackupAt: this.now().toISOString(),
				lastObjectKey: key,
				lastBytes: packed.bytes,
				lastFiles: packed.files,
				lastRemoved: 0,
				lastError: '',
			})
			let removed = 0
			let cleanupError = ''
			try {
				// Retention is decided on the key order: the timestamps sort.
				// Only snapshots take part — other objects under the prefix stay.
				const keys = (await client.listObjects(`${config.prefix}/`))
					.filter((candidate) => isBackupKey(config.prefix, candidate))
					.sort()
				const excess = keys.slice(0, Math.max(0, keys.length - config.keep))
				for (const old of excess) await client.deleteObject(old)
				removed = excess.length
				await this.settings.updateStatus({ lastRemoved: removed }).catch(() => {})
			} catch (error) {
				cleanupError = error instanceof Error ? error.message : String(error)
				await this.settings.updateStatus({
					lastError: `快照已上传，但清理旧备份失败：${cleanupError}`,
				}).catch(() => {})
				this.logger?.warn?.(`dsh-evolver: backup cleanup failed: ${cleanupError}`)
			}
			this.logger?.info?.(`dsh-evolver: backup ${key} (${packed.bytes} bytes, ${packed.files} files, ${removed} old)`)
			return {
				key,
				bytes: packed.bytes,
				files: packed.files,
				removed,
				reason,
				...(cleanupError === '' ? {} : { cleanupError }),
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			await this.settings.updateStatus({ lastError: message }).catch(() => {})
			this.logger?.warn?.(`dsh-evolver: backup failed: ${message}`)
			throw error
		} finally {
			this.running = false
			await rm(directory, { recursive: true, force: true }).catch(() => {})
		}
	}

	/**
	 * Prove the credentials and the bucket work.
	 *
	 * @returns {Promise<{endpoint: string, keys: string[]}>} What the server answered.
	 */
	async testConnection() {
		const readiness = this.readiness()
		if (!readiness.ready) throw new Error(`云端备份配置不完整：缺少 ${readiness.missing.join('、')}。`)
		const client = this.client()
		const keys = await client.check()
		return { endpoint: client.baseUrl(), keys }
	}

	/**
	 * The heartbeat: back up when the interval has passed.
	 *
	 * @returns {Promise<void>} Resolves when the check is done.
	 */
	async tick() {
		const config = this.settings.get().backup
		if (!config.enabled || this.running) return
		// An incomplete configuration is not retried every minute: there is
		// nothing to retry until the user saves the missing fields.
		if (!this.readiness().ready) return
		const status = this.settings.get().status
		const now = this.now().getTime()
		const interval = config.intervalMinutes * 60_000
		const last = Date.parse(status.lastBackupAt)
		if (Number.isFinite(last) && now - last < interval) return
		// After a failure, give the endpoint five minutes before trying again,
		// so a dead network does not mean one request per heartbeat forever.
		const attempted = Date.parse(status.lastAttemptAt)
		if (status.lastError !== '' && Number.isFinite(attempted) && now - attempted < 5 * 60_000) return
		try {
			await this.runNow({ reason: 'schedule' })
		} catch {
			// runNow already recorded the failure; a heartbeat must not throw.
		}
	}

	/** Start the scheduler. */
	start() {
		if (this.timer !== undefined) return
		this.timer = setInterval(() => {
			void this.tick()
		}, this.heartbeatMs)
		this.timer.unref?.()
		this.startup = setTimeout(() => {
			this.startup = undefined
			void this.tick()
		}, STARTUP_DELAY_MS)
		this.startup.unref?.()
	}

	/** Stop the scheduler. */
	stop() {
		if (this.timer !== undefined) {
			clearInterval(this.timer)
			this.timer = undefined
		}
		if (this.startup !== undefined) {
			clearTimeout(this.startup)
			this.startup = undefined
		}
	}
}
