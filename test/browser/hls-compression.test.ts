import { beforeAll, expect, test } from 'vitest';
import { commands } from '@vitest/browser/context';
import {
	BufferTarget, CanvasSource, EncodedPacketSink, HLS_FORMATS, Input, MpegTsOutputFormat, Output, UrlSource,
} from '../../src/index.js';

let segment: number[];
beforeAll(async () => {
	const target = new BufferTarget();
	const output = new Output({ format: new MpegTsOutputFormat(), target });
	const canvas = new OffscreenCanvas(64, 64);
	canvas.getContext('2d')!.fillRect(0, 0, 64, 64);
	const video = new CanvasSource(canvas, { codec: 'avc', bitrate: 100_000 });
	output.addVideoTrack(video);
	await output.start();
	await video.add(0, 0.5);
	await video.add(0.5, 0.5);
	await output.finalize();
	segment = [...new Uint8Array(target.buffer!)];
});

const cases = ['plain', 'br', 'br-no-range', 'br-no-range-no-size'] as const;
test.each(cases)('Reads the complete %s HLS playlist across origins', async (encoding) => {
	const fixture = await commands.startHlsCompressionServer(segment);
	const directory = encoding === 'plain' ? 'plain' : 'br';
	const url = `${fixture.origin}/${directory}/playlist.m3u8`;
	try {
		expect(fixture.origin).not.toBe(location.origin);
		expect(fixture.compressedLength).toBeLessThan(fixture.decodedLength);
		expect(fixture.segmentName.startsWith(fixture.truncatedLastLine)).toBe(true);
		expect(fixture.truncatedLastLine.length).toBeGreaterThan(0);
		expect(fixture.truncatedLastLine).not.toBe(fixture.segmentName);
		const response = await fetch(url);
		const text = await response.text();
		console.log('Native fetch', {
			encoding, browser: navigator.userAgent, headers: Object.fromEntries(response.headers.entries()),
			decodedLength: new TextEncoder().encode(text).length,
			compressedLength: fixture.compressedLength, truncatedLastLine: fixture.truncatedLastLine,
		});
		expect(response.status).toBe(200);
		expect(response.type).toBe('cors');
		expect(response.headers.get('content-encoding')).toBeNull();
		expect(Number(response.headers.get('content-length'))).toBe(
			directory === 'br' ? fixture.compressedLength : fixture.decodedLength,
		);
		expect(text).toBe(fixture.playlist);

		using input = new Input({
			source: new UrlSource(url, {
				getRetryDelay: () => null,
				// Diagnostics only: isolate playlist length handling if Chrome rejects compressed Range responses.
				fetchFn: encoding.startsWith('br-no-range')
					? async (resource, init) => {
						const request = new Request(resource, init);
						if (!new URL(request.url).pathname.endsWith('.m3u8')) return fetch(request);
						request.headers.delete('Range');
						const response = await fetch(request);
						if (encoding !== 'br-no-range-no-size') return response;
						const headers = new Headers(response.headers);
						headers.delete('content-length');
						headers.delete('content-range');
						return new Response(response.body, { status: response.status, headers });
					}
					: undefined,
			}),
			formats: HLS_FORMATS,
		});
		const track = await input.getPrimaryVideoTrack();
		expect(track).not.toBeNull();
		const timestamps = [];
		for await (const packet of new EncodedPacketSink(track!).packets()) {
			timestamps.push(packet.timestamp);
		}
		expect(timestamps).toEqual([0, 0.5]);
	} finally {
		const requests = await commands.stopHlsCompressionServer();
		console.log('HLS HTTP requests', { encoding, requests });
		expect.soft(requests.filter(x => !x.path.endsWith('/playlist.m3u8')).map(x => x.path)).toEqual([
			`/${directory}/${fixture.segmentName}`,
		]);
		expect.soft(requests.every(x => x.status === 200)).toBe(true);
	}
});
