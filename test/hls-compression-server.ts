import http from 'node:http';
import { brotliCompressSync } from 'node:zlib';
import type { BrowserCommand } from 'vitest/node';

const segmentName = `segment-${'a'.repeat(160)}.ts`;
const playlist = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n'
	+ `${segmentName}\n#EXT-X-ENDLIST\n#${'synthetic playlist comment '.repeat(150)}\n`;
const plain = Buffer.from(playlist);
const compressed = brotliCompressSync(plain);
const requests: { path: string; range: string | null; status: number }[] = [];
let server: http.Server | undefined;

const startHlsCompressionServer: BrowserCommand<[number[]]> = async (_context, bytes) => {
	if (server) throw new Error('HLS compression server already running');
	if (!Array.isArray(bytes) || !bytes.length || bytes.some(x => !Number.isInteger(x) || x < 0 || x > 255)) {
		throw new Error('Expected synthetic segment bytes');
	}
	requests.length = 0;
	const segment = Buffer.from(bytes);
	server = http.createServer((req, res) => {
		const pathname = new URL(req.url!, 'http://localhost').pathname;
		const isPlaylist = pathname === '/plain/playlist.m3u8' || pathname === '/br/playlist.m3u8';
		const isSegment = pathname === `/plain/${segmentName}` || pathname === `/br/${segmentName}`;
		const body = isPlaylist
			? (pathname.startsWith('/br/') ? compressed : plain)
			: isSegment ? segment : Buffer.alloc(0);
		const status = isPlaylist || isSegment ? 200 : 404;
		requests.push({ path: pathname, range: req.headers.range ?? null, status });
		// A separate loopback origin, with ordinary CORS and no exposed Content-Encoding.
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Cache-Control', 'no-store');
		res.setHeader('Content-Type', isPlaylist ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
		res.setHeader('Content-Length', body.length);
		if (pathname === '/br/playlist.m3u8') res.setHeader('Content-Encoding', 'br');
		// Deliberately ignore Range, as permitted for an HTTP 200 response.
		res.writeHead(status);
		res.end(body);
	});
	await new Promise<void>((resolve, reject) => {
		server!.once('error', reject);
		server!.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Expected TCP address');
	return {
		origin: `http://127.0.0.1:${address.port}`, playlist, segmentName,
		decodedLength: plain.length, compressedLength: compressed.length,
		truncatedLastLine: playlist.slice(0, compressed.length).split('\n').at(-1),
	};
};

const stopHlsCompressionServer: BrowserCommand<[]> = async () => {
	const current = server;
	server = undefined;
	if (current) {
		await new Promise<void>((resolve, reject) => {
			current.close(error => error ? reject(error) : resolve());
			current.closeAllConnections();
		});
	}
	return requests.splice(0);
};

export const hlsCompressionCommands = { startHlsCompressionServer, stopHlsCompressionServer };

declare module '@vitest/browser/context' {
	interface BrowserCommands {
		startHlsCompressionServer: (bytes: number[]) => Promise<{
			origin: string; playlist: string; segmentName: string;
			decodedLength: number; compressedLength: number; truncatedLastLine: string;
		}>;
		stopHlsCompressionServer: () => Promise<typeof requests>;
	}
}
