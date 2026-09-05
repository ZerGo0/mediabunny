import { createServer } from 'node:http';
import { brotliCompressSync, constants } from 'node:zlib';
import { build } from 'esbuild';
import {
	BufferTarget, EncodedAudioPacketSource, EncodedPacket, MpegTsOutputFormat, Output,
} from '../../src/index.js';
import { inlineWorkerPlugin } from '../esbuild/inlined-workers.js';

// Two origins, both loopback. No application, credentials, or external media needed.
const pageOrigin = 'http://127.0.0.1:8765';
const mediaOrigin = 'http://127.0.0.1:8766';
const segmentDuration = 48 * 1024 / 48000;
const segments = new Map<string, Buffer>();
for (let index = 0; index < 2; index++) {
	const target = new BufferTarget();
	const output = new Output({ format: new MpegTsOutputFormat(), target });
	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);
	await output.start();
	for (let frame = 0; frame < 48; frame++) {
		// AAC-LC stereo silence, raw access unit (no ADTS header).
		await source.add(new EncodedPacket(
			new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]),
			'key', (index * 48 + frame) * 1024 / 48000, 1024 / 48000,
		), { decoderConfig: {
			codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2,
			description: new Uint8Array([0x11, 0x90]),
		} });
	}
	await output.finalize();
	segments.set(`segment-${index}.ts`, Buffer.from(target.buffer!));
}

// Find a fixed point: the encoded byte length ends six bytes into the first URI.
// Search rather than pin Brotli output across Node/zlib versions; fail loudly if absent.
let playlist = '';
let compressed = Buffer.alloc(0);
for (let padding = 0; padding < 4096; padding++) {
	const prefix = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n'
		+ '#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n'
		+ `#${'x'.repeat(padding)}\n#EXTINF:${segmentDuration},\n`;
	const candidate = prefix + 'segment-0.ts\n'
		+ `#EXTINF:${segmentDuration},\nsegment-1.ts\n#EXT-X-ENDLIST\n#${'fixture '.repeat(450)}\n`;
	const encoded = brotliCompressSync(candidate, {
		params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
	});
	if (encoded.length === Buffer.byteLength(prefix) + 'segmen'.length) {
		playlist = candidate;
		compressed = encoded;
		break;
	}
}
if (!playlist) throw new Error('Unable to align compressed length with segmen');

const requests: object[] = [];
const mediaServer = createServer((req, res) => {
	const url = new URL(req.url!, mediaOrigin);
	res.setHeader('Access-Control-Allow-Origin', pageOrigin);
	res.setHeader('Access-Control-Allow-Credentials', 'true');
	res.setHeader('Access-Control-Allow-Headers', 'Range');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	// Content-Length is CORS safelisted. Deliberately do not expose Content-Encoding.
	res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
	res.setHeader('Cache-Control', 'no-store');
	if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
	if (req.method !== 'GET') { res.writeHead(405).end(); return; }
	const record = { path: url.pathname, range: req.headers.range ?? null, status: 200 };
	requests.push(record);
	if (/^\/(br|plain|stripped|no-range)\/entry\.m3u8$/.test(url.pathname)) {
		record.status = 302;
		res.writeHead(302, { Location: url.pathname.replace('/entry.m3u8', '/nested/index.m3u8') }).end();
		return;
	}
	if (/^\/(br|plain|stripped|no-range)\/nested\/index\.m3u8$/.test(url.pathname)) {
		const body = url.pathname.startsWith('/plain/') ? Buffer.from(playlist) : compressed;
		res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
		res.setHeader('Content-Length', body.length);
		if (!url.pathname.startsWith('/plain/')) res.setHeader('Content-Encoding', 'br');
		// A server may ignore Range and send the full representation with HTTP 200.
		res.end(body);
		return;
	}
	const match = /^\/(br|plain|stripped|no-range)\/nested\/(segment-[01]\.ts)$/.exec(url.pathname);
	const segment = match && segments.get(match[2]!);
	if (!segment) { record.status = 404; res.writeHead(404).end('Unknown segment'); return; }
	res.setHeader('Content-Type', 'video/mp2t');
	res.setHeader('Accept-Ranges', 'bytes');
	let start = 0;
	let end = segment.length - 1;
	if (req.headers.range) {
		const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
		start = range ? Number(range[1]) : NaN;
		end = range?.[2] ? Math.min(Number(range[2]), end) : end;
		if (!Number.isSafeInteger(start) || start < 0 || start > end) {
			record.status = 416;
			res.writeHead(416, { 'Content-Range': `bytes */${segment.length}` }).end();
			return;
		}
		record.status = 206;
		res.statusCode = 206;
		res.setHeader('Content-Range', `bytes ${start}-${end}/${segment.length}`);
	}
	res.setHeader('Content-Length', end - start + 1);
	res.end(segment.subarray(start, end + 1));
});

const bundle = await build({
	entryPoints: ['scripts/repro-hls-content-length/browser.ts'],
	bundle: true, write: false, format: 'esm', target: 'es2022',
	plugins: [inlineWorkerPlugin({})],
});
const pageServer = createServer((req, res) => {
	res.setHeader('Cache-Control', 'no-store');
	if (req.url === '/browser.js') {
		res.setHeader('Content-Type', 'text/javascript');
		res.end(bundle.outputFiles[0]!.contents);
	} else if (req.url === '/evidence') {
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({
			playlist, compressedBytes: compressed.length, decodedBytes: Buffer.byteLength(playlist), requests,
		}));
	} else {
		res.setHeader('Content-Type', 'text/html');
		res.end('<!doctype html><title>HLS compressed Content-Length reproduction</title>'
			+ '<h1>HLS compressed Content-Length reproduction</h1><button id="run">Run reproduction</button>'
			+ '<pre id="result">Ready</pre><script type="module" src="/browser.js"></script>');
	}
});
mediaServer.listen(8766, '127.0.0.1');
pageServer.listen(8765, '127.0.0.1');
console.log(`Open ${pageOrigin}; playlist: ${compressed.length} compressed / ${Buffer.byteLength(playlist)} decoded bytes`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => { pageServer.close(); mediaServer.close(); });
}
