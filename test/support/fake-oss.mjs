import { createServer } from 'node:http'

/**
 * A fake OSS endpoint that speaks enough of the API for the backup client.
 *
 * The client is exercised through real HTTP so the URL shape, the signature
 * headers and the XML parsing all get used, without any credentials.
 *
 * @returns {Promise<object>} The server and the objects it holds.
 */
export async function fakeOss() {
	const objects = new Map()
	const requests = []
	const state = { failNext: false }
	const server = createServer(async (request, response) => {
		const url = new URL(request.url, 'http://127.0.0.1')
		const key = decodeURIComponent(url.pathname.replace(/^\/test\/?/, ''))
		const chunks = []
		for await (const chunk of request) chunks.push(chunk)
		requests.push({
			method: request.method,
			key,
			headers: request.headers,
			query: url.searchParams,
			body: Buffer.concat(chunks),
		})
		if (state.failNext) {
			state.failNext = false
			response.writeHead(403, { 'content-type': 'application/xml' })
			response.end('<Error><Code>AccessDenied</Code><Message>nope</Message></Error>')
			return
		}
		if (request.method === 'PUT') {
			objects.set(key, Buffer.concat(chunks))
			response.writeHead(200).end()
			return
		}
		if (request.method === 'GET') {
			const prefix = url.searchParams.get('prefix') ?? ''
			const keys = [...objects.keys()].filter((item) => item.startsWith(prefix)).sort()
			response.writeHead(200, { 'content-type': 'application/xml' })
			response.end(`<ListBucketResult>${keys.map((item) => `<Contents><Key>${item}</Key></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`)
			return
		}
		if (request.method === 'DELETE') {
			objects.delete(key)
			response.writeHead(204).end()
			return
		}
		response.writeHead(405).end()
	})
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	return {
		url: `http://127.0.0.1:${address.port}`,
		objects,
		requests,
		get failNext() {
			return state.failNext
		},
		set failNext(value) {
			state.failNext = value
		},
		close: () => new Promise((resolve) => server.close(resolve)),
	}
}
