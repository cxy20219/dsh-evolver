/**
 * A minimal Aliyun OSS client (V1 signature).
 *
 * The plugin ships without dependencies, so this speaks the documented REST
 * API directly: HMAC-SHA1 over a canonical string, one `Authorization` header,
 * and the few operations a backup needs (PUT, LIST, DELETE).
 *
 * Endpoints come in two shapes:
 *
 *   `oss-cn-hangzhou.aliyuncs.com`  virtual-hosted: `https://<bucket>.<host>`
 *   `https://gateway.example.com`   path style: `<gateway>/<bucket>`
 *
 * The second form is what a self-hosted, S3-compatible gateway looks like, and
 * it is also what the tests use. Object keys are restricted to safe ASCII, so
 * the signed resource and the request path are always the same string.
 */

import { createHash, createHmac } from 'node:crypto'

/** How long one OSS request may take. */
const REQUEST_TIMEOUT_MS = 60_000

/** How many list pages a retention pass will follow. */
const MAX_PAGES = 20

/** The subresources OSS signs as part of the canonical resource. */
const SIGNED_SUBRESOURCES = new Set([
	'acl', 'uploads', 'location', 'cors', 'logging', 'website', 'referer',
	'lifecycle', 'delete', 'append', 'tagging', 'objectMeta', 'uploadId',
	'partNumber', 'security-token', 'x-oss-process', 'response-content-type',
	'response-content-language', 'response-expires', 'response-cache-control',
	'response-content-disposition', 'response-content-encoding',
])

/**
 * The canonical resource for one request.
 *
 * @param {string} bucket - Bucket name.
 * @param {string} key - Object key, empty for a bucket-level request.
 * @param {Record<string, string>} [query] - Query parameters.
 * @returns {string} The canonical resource.
 */
export function canonicalResource(bucket, key = '', query = {}) {
	const base = key === '' ? `/${bucket}/` : `/${bucket}/${key}`
	const signed = Object.keys(query)
		.filter((name) => SIGNED_SUBRESOURCES.has(name))
		.sort()
	// A subresource without a value is signed as its bare name (`?acl`).
	return signed.length === 0
		? base
		: `${base}?${signed.map((name) => (query[name] === '' ? name : `${name}=${query[name]}`)).join('&')}`
}

/**
 * The OSS V1 string to sign.
 *
 * @param {object} request - The request parts.
 * @param {string} request.method - HTTP method.
 * @param {string} [request.contentMd5] - Content-MD5 header.
 * @param {string} [request.contentType] - Content-Type header.
 * @param {string} request.date - Date header.
 * @param {Record<string, string>} [request.headers] - All headers.
 * @param {string} request.resource - Canonical resource.
 * @returns {string} The string to sign.
 */
export function stringToSign({ method, contentMd5 = '', contentType = '', date, headers = {}, resource }) {
	const canonicalHeaders = Object.entries(headers)
		.map(([name, value]) => [String(name).toLowerCase(), String(value ?? '').trim()])
		.filter(([name]) => name.startsWith('x-oss-'))
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([name, value]) => `${name}:${value}\n`)
		.join('')
	return `${String(method).toUpperCase()}\n${contentMd5}\n${contentType}\n${date}\n${canonicalHeaders}${resource}`
}

/**
 * Sign one request.
 *
 * @param {string} secret - Access key secret.
 * @param {object} request - The same parts `stringToSign` takes.
 * @returns {string} The base64 signature.
 */
export function signRequest(secret, request) {
	return createHmac('sha1', secret).update(stringToSign(request)).digest('base64')
}

/**
 * Unescape the five XML entities an OSS listing can contain.
 *
 * @param {string} value - The text.
 * @returns {string} The unescaped text.
 */
function unescapeXml(value) {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&')
}

/**
 * The keys of one ListObjects response.
 *
 * @param {string} xml - The response body.
 * @returns {string[]} The keys, in response order.
 */
export function parseKeys(xml) {
	const keys = []
	for (const match of String(xml ?? '').matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
		const key = /<Key>([\s\S]*?)<\/Key>/.exec(match[1])
		if (key !== null) keys.push(unescapeXml(key[1]))
	}
	return keys
}

/**
 * Whether a listing has another page.
 *
 * @param {string} xml - The response body.
 * @returns {boolean} True when the result is truncated.
 */
function isTruncated(xml) {
	return /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(String(xml ?? ''))
}

/**
 * The code and message of an OSS error response.
 *
 * @param {string} xml - The response body.
 * @param {number} status - The HTTP status.
 * @returns {string} A message without any credential material.
 */
function errorMessage(xml, status) {
	const code = /<Code>([\s\S]*?)<\/Code>/.exec(String(xml ?? ''))
	const message = /<Message>([\s\S]*?)<\/Message>/.exec(String(xml ?? ''))
	if (code === null && message === null) return `HTTP ${status}`
	const parts = [code === null ? '' : unescapeXml(code[1]), message === null ? '' : unescapeXml(message[1])]
	return `HTTP ${status} ${parts.filter((part) => part !== '').join(': ')}`
}

/**
 * The OSS client.
 */
export class OssClient {
	/**
	 * @param {{endpoint: string, bucket: string, accessKeyId: string, accessKeySecret: string, timeoutMs?: number}} config - The connection.
	 */
	constructor({ endpoint, bucket, accessKeyId, accessKeySecret, timeoutMs = REQUEST_TIMEOUT_MS }) {
		this.endpoint = String(endpoint ?? '').trim().replace(/\/+$/, '')
		this.bucket = String(bucket ?? '').trim()
		this.accessKeyId = String(accessKeyId ?? '').trim()
		this.accessKeySecret = String(accessKeySecret ?? '')
		this.timeoutMs = timeoutMs
	}

	/**
	 * The base URL a request starts from.
	 *
	 * @returns {string} The base, without a trailing slash.
	 */
	baseUrl() {
		if (/^https?:\/\//i.test(this.endpoint)) {
			// Path style: the endpoint already addresses the gateway and the
			// bucket becomes the first path segment.
			return `${this.endpoint.replace(/\/+$/, '')}/${this.bucket}`
		}
		return `https://${this.bucket}.${this.endpoint.replace(/\/+$/, '')}`
	}

	/**
	 * Whether the configured connection has everything a request needs.
	 *
	 * @returns {boolean} True when it can be used.
	 */
	configured() {
		return this.endpoint !== '' && this.bucket !== '' && this.accessKeyId !== '' && this.accessKeySecret !== ''
	}

	/**
	 * Build the URL for one object key.
	 *
	 * @param {string} key - Object key.
	 * @param {Record<string, string>} [query] - Query parameters.
	 * @returns {URL} The URL.
	 */
	objectUrl(key, query = {}) {
		const encodedKey = key === ''
			? ''
			: key.split('/').map((segment) => encodeURIComponent(segment)).join('/')
		const url = new URL(`${this.baseUrl()}/${encodedKey}`)
		for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
		return url
	}

	/**
	 * Send one signed request.
	 *
	 * @param {{method: string, key?: string, query?: Record<string, string>, body?: Buffer, contentType?: string}} request - The request.
	 * @returns {Promise<Response>} The response.
	 */
	async send({ method, key = '', query = {}, body, contentType = '' }) {
		const url = this.objectUrl(key, query)
		const date = new Date().toUTCString()
		const contentMd5 = body === undefined ? '' : createHash('md5').update(body).digest('base64')
		const headers = { Date: date }
		if (contentType !== '') headers['Content-Type'] = contentType
		if (contentMd5 !== '') headers['Content-MD5'] = contentMd5
		const resource = canonicalResource(this.bucket, key, query)
		headers.Authorization = `OSS ${this.accessKeyId}:${signRequest(this.accessKeySecret, {
			method,
			contentMd5,
			contentType,
			date,
			headers,
			resource,
		})}`
		let response
		try {
			response = await fetch(url, {
				method,
				headers,
				...(body === undefined ? {} : { body }),
				signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(this.timeoutMs) : undefined,
			})
		} catch (error) {
			throw new Error(`OSS 请求失败：${error instanceof Error ? error.message : String(error)}`)
		}
		if (response.ok) return response
		const text = await response.text().catch(() => '')
		throw new Error(`OSS 请求失败：${errorMessage(text, response.status)}`)
	}

	/**
	 * Upload one object.
	 *
	 * @param {string} key - Object key.
	 * @param {Buffer} body - The bytes.
	 * @param {string} [contentType] - The content type.
	 * @returns {Promise<number>} The uploaded size.
	 */
	async putObject(key, body, contentType = 'application/x-tar') {
		await this.send({ method: 'PUT', key, body, contentType })
		return body.length
	}

	/**
	 * List every object under one prefix.
	 *
	 * @param {string} prefix - The prefix.
	 * @returns {Promise<string[]>} The keys.
	 */
	async listObjects(prefix) {
		const keys = []
		let marker = ''
		for (let page = 0; page < MAX_PAGES; page += 1) {
			const query = { prefix, 'max-keys': '1000' }
			if (marker !== '') query.marker = marker
			const response = await this.send({ method: 'GET', query })
			const xml = await response.text()
			const pageKeys = parseKeys(xml)
			keys.push(...pageKeys)
			if (!isTruncated(xml) || pageKeys.length === 0) break
			marker = pageKeys[pageKeys.length - 1]
		}
		return keys
	}

	/**
	 * Delete one object.
	 *
	 * @param {string} key - Object key.
	 * @returns {Promise<void>} Resolves once the server accepted it.
	 */
	async deleteObject(key) {
		await this.send({ method: 'DELETE', key })
	}

	/**
	 * Ask the server for one key: the cheapest way to prove the credentials
	 * and the bucket actually work.
	 *
	 * @returns {Promise<string[]>} The first keys of the bucket.
	 */
	async check() {
		const response = await this.send({ method: 'GET', query: { 'max-keys': '1' } })
		return parseKeys(await response.text())
	}
}
