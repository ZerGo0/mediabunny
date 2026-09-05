import {
	ALL_FORMATS, BufferSource, BufferTarget, Conversion, EncodedPacketSink, Input, Mp4OutputFormat, Output, UrlSource,
} from '../../src/index.js';

const mediaOrigin = 'http://127.0.0.1:8766';
const result = document.querySelector<HTMLPreElement>('#result')!;
const button = document.querySelector<HTMLButtonElement>('#run')!;

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function run() {
	const evidence = await fetch('/evidence').then(r => r.json()) as {
		playlist: string; compressedBytes: number; decodedBytes: number;
	};
	const response = await fetch(`${mediaOrigin}/br/entry.m3u8`, { credentials: 'include' });
	const text = await response.text();
	const headers = {
		status: response.status, contentLength: response.headers.get('content-length'),
		contentEncoding: response.headers.get('content-encoding'),
		decodedBytes: new TextEncoder().encode(text).length,
		redirected: response.redirected, url: response.url,
		truncatedTail: text.slice(0, evidence.compressedBytes).split('\n').at(-1),
	};
	check(text === evidence.playlist, 'Browser did not receive the complete decoded playlist');
	check(Number(headers.contentLength) === evidence.compressedBytes, 'Wrong encoded Content-Length');
	check(headers.contentEncoding === null, 'Content-Encoding must be hidden by CORS');
	check(headers.decodedBytes > evidence.compressedBytes, 'Fixture must compress');
	check(headers.truncatedTail === 'segmen', 'Fixture alignment changed');

	const cases = [];
	for (const mode of ['br', 'no-range', 'plain', 'stripped']) {
		const requests: { url: string; range: string | null; status: number }[] = [];
		const fetchFn: typeof fetch = async (resource, init) => {
			const request = new Request(resource, init);
			const isPlaylist = new URL(request.url).pathname.endsWith('.m3u8');
			if (mode === 'no-range' && isPlaylist) request.headers.delete('Range');
			const response = await fetch(request);
			requests.push({ url: response.url, range: request.headers.get('Range'), status: response.status });
			if (mode !== 'stripped' || !isPlaylist) return response;
			const headers = new Headers(response.headers);
			headers.delete('content-length');
			headers.delete('content-range');
			const replacement = new Response(response.body, {
				status: response.status, statusText: response.statusText, headers,
			});
			// A plain new Response loses these, breaking relative paths after redirects.
			Object.defineProperties(replacement, {
				url: { value: response.url }, redirected: { value: response.redirected },
			});
			return replacement;
		};
		const input = new Input({
			formats: ALL_FORMATS,
			source: new UrlSource(`${mediaOrigin}/${mode}/entry.m3u8`, {
				requestInit: { credentials: 'include' }, fetchFn, getRetryDelay: () => null,
			}),
		});
		let error: string | null = null;
		let outputBytes = 0;
		let packets = 0;
		try {
			const target = new BufferTarget();
			const output = new Output({ format: new Mp4OutputFormat(), target });
			const conversion = await Conversion.init({ input, output });
			check(conversion.isValid, 'Conversion has no usable tracks');
			await conversion.execute();
			outputBytes = target.buffer!.byteLength;
			const exported = new Input({ formats: ALL_FORMATS, source: new BufferSource(target.buffer!) });
			try {
				const track = await exported.getPrimaryAudioTrack();
				check(track, 'Export has no audio track');
				for await (const _packet of new EncodedPacketSink(track).packets()) packets++;
				check(packets === 96, `Expected all 96 audio packets, got ${packets}`);
			} finally { exported.dispose(); }
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally { input.dispose(); }
		cases.push({ mode, error, outputBytes, packets, requests });
	}
	const raw = cases[0]!;
	const noRange = cases[1]!;
	const controls = cases.slice(2);
	const reproduced = [raw, noRange].every(c => c.error && c.requests.some(
		r => r.url.endsWith('/nested/segmen') && r.status === 404,
	)) && controls.every(c => !c.error && c.packets === 96
		&& c.requests.some(r => r.url.endsWith('/nested/segment-1.ts') && r.status === 206));
	const report = { reproduced, browser: navigator.userAgent, headers, cases };
	result.textContent = JSON.stringify(report, null, 2);
	result.dataset['verdict'] = reproduced ? 'reproduced' : 'unexpected';
}

button.addEventListener('click', () => {
	button.disabled = true;
	result.textContent = 'Running…';
	void run().catch((error: unknown) => {
		result.textContent = String(error);
		result.dataset['verdict'] = 'unexpected';
	}).finally(() => { button.disabled = false; });
});
