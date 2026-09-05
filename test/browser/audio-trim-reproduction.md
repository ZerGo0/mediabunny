# Reproduction: trimming video after its audio ends

Suggested PR title: `test: reproduce audio trim RangeError after audio ends`

This is a reproduction/test-only change for fork issue #1. It adds six synthetic
cases to the existing conversion browser tests. Two assert successful export but
currently fail with the reported exception; four controls pass. No production fix,
expected-exception assertion, skip, or expected-failure marker is included.

## Revision and environment

- Tested fork HEAD: `39dbdd4fcdbca411381f15cb4fde01c009cb58e9`, Mediabunny **1.55.7**.
- Synced upstream: `c67c5e4072cf834743498c45a5a5bdf058947aec`. The only subsequent
  commit deletes `CLAUDE.md`; production source is unchanged from that sync.
- Linux; Node `24.20.0`, npm `11.19.0`, Vitest `3.2.4`, WebdriverIO `9.19.2`,
  Google Chrome `152.0.7977.64`, Xvfb `21.1.12`.
- Uses the repository's headed Chrome browser project under Xvfb, as in CI.
  No separate application, browser harness, or test configuration was added.
- This verifies the requested synced upstream revision, not a claim about any
  newer upstream commits published after that sync.

## Runnable commands

From the repository root, with Chrome and Xvfb installed:

```sh
npm ci
xvfb-run -a npm test -- browser/conversion.test.ts -t 'Trim video continuing after audio'
```

The focused command exits **1**, with **2 failed / 4 passed**. `npm test` runs the
normal `pre-test` bundling step before Vitest. The new tests take about one second
inside Chrome (roughly 3–6 seconds including runner startup, excluding bundling).

Additional final checks:

```sh
npx eslint test/browser/conversion.test.ts --fix
xvfb-run -a npm test -- browser/conversion.test.ts
npm run check
```

## Fixture and assertions

Each case generates a 10-second, 64×64 H.264 video at 2 fps and AAC audio using the
existing `addAacPackets` helper (48 kHz, 1024 frames per packet). No media binary is
added. HLS cases remux the generated MP4 into in-memory MPEG-TS segments through
`Conversion`, `PathedTarget`, and `CustomPathedSource`, following existing tests.
The H.264 profile/level is explicit: the default tiny-frame configuration emitted
`avc1.640c09`, which this Chrome could encode but would reject for decoding.

Audio transcoding is forced, targeting Opus in MP4 so the test does not depend on
AAC encoder availability on Linux. This exercises decoded AAC sample trimming;
it is not a packet-copy-only test. The tests reject discarded input tracks,
require finalized output, decode and check every output video frame's timestamp
and count, and check decoded output audio presence and timing. An absent or empty
output audio track is accepted when the clip contains no audio; stale audio is not.

| Input | Audio duration requested | Clip | Result on 1.55.7 |
| --- | --- | --- | --- |
| MP4 | 4 s | 5–10 s | `RangeError: startSample out of range.` |
| HLS / MPEG-TS | 4 s | 5–10 s | Same RangeError |
| MP4 | 4 s | 3–10 s | Pass; overlapping audio retained |
| HLS / MPEG-TS | 4 s | 3–10 s | Pass; overlapping audio retained |
| MP4 | 10 s | 5–10 s | Pass; continuous-audio control |
| HLS / MPEG-TS | 10 s | 5–10 s | Pass; continuous-audio control |

AAC duration rounds up to a complete packet: 4 s becomes approximately
4.010667 s. The fixture's actual audio duration is checked before conversion.

## Failure stack and sample bounds

The complete source-mapped failure stack emitted by the uninstrumented Vitest run
is identical for both failing cases:

```text
RangeError: startSample out of range.
 ❯ AudioSample.trim ../src/sample.ts:2881:9
 ❯ ../src/conversion.ts:1820:35
```

Temporary instrumentation at the iterator's post-flush enqueue and immediately
before `sample.trim` captured:

| Case (both MP4 and HLS) | Sample timestamp | Duration | Sample rate | Frames | Clip | startFrame | endFrame |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Minimal | 3.989333333333333 | 0.021333333333333333 | 48000 | 1024 | 5–10 | 48512 | 1024 |
| Long | 109.99466666666666 | 0.021333333333333333 | 48000 | 1024 | 115–120 | 240256 | 1024 |

The full raw browser stack from that instrumented minimal run (transformed code
line numbers, before source mapping) was:

```text
RangeError: startSample out of range.
    at AudioSample.trim (http://localhost:63315/@fs/home/runner/work/agent-github-bot/agent-github-bot/workspaces/23589f35-a8b3-4c7b-b949-5a4e6f3df8ff/src/sample.ts:1784:13)
    at http://localhost:63315/@fs/home/runner/work/agent-github-bot/agent-github-bot/workspaces/23589f35-a8b3-4c7b-b949-5a4e6f3df8ff/src/conversion.ts:1083:38
```

For the long experiment, the same test was temporarily configured with 600 video
frames at 2 fps, `audioDuration: 110`, and `trim: { start: 115, end: 120 }`, and run
with the same focused command. Both formats failed. These fixture substitutions
and all instrumentation were removed; only the minimal cases are retained.
The long sample differs from the issue's original timestamp `110.016` and start
frame `239232` by one AAC packet. The synthetic packet count here uses
`ceil(duration / (1024 / 48000))`; the original media is not available for an
identical packet-for-packet comparison.

## Mechanism and causal experiment

`BaseMediaSampleSink.mediaSamplesInRange` retains the last sample before the
requested start. After decoder flush, if no first sample has been queued, it
unconditionally enqueues that retained sample (`src/media-sink.ts:576`). In these
cases it is entirely before the requested interval. Conversion calculates
`round((clipStart - sample.timestamp) * sample.sampleRate)` without checking whether
the sample has already ended, then passes the result to `AudioSample.trim`.
The sample's range validation correctly rejects a start beyond its frame count.

This supports the retained-sample/flush explanation, rather than a container
remux timestamp shift or a one-frame rounding error: both containers produce
identical bounds, and the invalid start is tens of thousands of frames out of
range. The recent iterator termination change `6c88763` does not prevent it.

As a temporary causal check, adding only this guard at the start of Conversion's
decoded **audio** loop made all six tests pass, including their export and timeline
assertions:

```ts
if (sample.timestamp + sample.duration <= this._startTimestamp) {
    continue;
}
```

The guard was removed. This is evidence for a possible solution, not a reviewed
production fix. A future fix must retain overlapping samples and preserve their
original timestamps relative to the clip start. It should also consider iterator
semantics, gaps, late-starting audio, fractional sample boundaries, and cleanup;
these six cases do not establish correctness for all of those situations.

## Historical verification: 1.55.3

The same six tests also reproduce both failures on **1.55.3**, commit
`16f8889e144f2bbeaa6a6788009abb4ecef19847`, in a detached worktree. The four controls
pass there too. No intervening fix explains a difference: both tested versions
fail. The historical run uses historical production source and the same installed
browser/tool dependencies, rather than a separately installed historical lockfile.

Setup from the current repository root (paths shown for the actual run):

```sh
git worktree add --detach /tmp/mediabunny-1.55.3 16f8889e144f2bbeaa6a6788009abb4ecef19847
ln -s "$PWD/node_modules" /tmp/mediabunny-1.55.3/node_modules
cp test/browser/conversion.test.ts /tmp/mediabunny-1.55.3/test/browser/conversion.test.ts
cd /tmp/mediabunny-1.55.3
script -q -e -c "xvfb-run -a npm test -- browser/conversion.test.ts -t 'Trim video continuing after audio'" /tmp/audio-trim-old-version.log
```

Result: **2 failed / 4 passed / 20 skipped**, exit 1. Vitest's error annotations
identify `/tmp/mediabunny-1.55.3/src/sample.ts`, confirming the isolated source path.
The complete source-mapped stack is:

```text
RangeError: startSample out of range.
 ❯ AudioSample.trim ../src/sample.ts:2836:9
 ❯ ../src/conversion.ts:1820:35
```

The sample-bounds probes and long case were run on 1.55.7 only.

## Final verification and review status

- `npx eslint test/browser/conversion.test.ts --fix`: passed.
- `npm run check`: passed, including source, packages, test, script, and Vite
  TypeScript checks.
- `xvfb-run -a npm test -- browser/conversion.test.ts`: **24 passed / 2 failed**;
  only the two new after-audio-end regressions fail. All 20 pre-existing conversion
  tests pass. Other browser files and the Node suite were not run for this
  test/documentation-only change.
- All temporary instrumentation and production guard edits were removed; the
  production source is identical to the starting checkout.
- This patch intentionally leaves CI red to expose the bug. It is ready for review
  as a reproduction, not ready to merge under a requirement for green CI. No
  commit, push, or remote PR was created; no upstream publication was attempted.
