# Tandem release status

Tandem 0.3.3 is an experimental source preview distributed under the MIT license, preserving BB’s existing copyright and attribution. Source availability does not establish compatibility with stock BB.

## Installation boundary

- Builds against published Plugin SDK 0.6.144; the installed BB must support the SDK surfaces in use.
- Native Codex requires access to the backing thread’s existing Codex connection. The plugin prefers the proposed `threads.experimental_voice` operation and retains the customized `threads.voice` operation for the current installation. No second writer or API-key fallback is supported.
- Native cached briefing requires the startup-briefing bridge, introduced with host protocol 269. Tandem sends the startup-briefing field on every native call, null when no briefing is ready, so that Cached briefing off stays retrieval-only on both bridges. Bridges older than protocol 269 have not been tested with it. Native voice selection requires the voice-selection extension, introduced with protocol 270.
- New-thread voice requires input-free thread initialization, introduced with protocol 271. Older BB versions reject that creation request.
- Claude transport requires an official Codex CLI signed in with ChatGPT on the BB server; Codex 0.160.1 has been exercised. Its experimental protocol may change. Tandem stops the temporary Codex realtime session and archives its thread as soon as it receives the SDP answer. Claude audio relies on the negotiated browser connection surviving that detachment. This is observed Codex behavior, not a documented guarantee; re-verify it with a fresh Claude call after each Codex upgrade.

These protocol numbers identify customized BB changes, not a stock-release compatibility guarantee. The supporting core changes are a separate dependency; this plugin source alone does not install them. See [maintainer context](maintainers.md) for the independent upstream PRs and the difference between the proposed API and the deployed custom build.

## Naming and upgrades

The plugin and BB project are called Tandem. The package remains `bb-plugin-live-voice` and its plugin ID remains `live-voice` to preserve existing settings, briefing data and diagnostics. The repository URL is unchanged. Keep `private: true` to prevent accidental npm publication; this does not prevent source distribution or BB Git installation.

The Cached briefing boolean replaces the former background dropdown. When upgrading from cached mode, enable the new toggle with `bb plugin config live-voice set cachedBriefing true`. Off and on apply to fresh calls. The deferred briefing/full comparison modes are retired; historical traces remain under bounded retention.

## Verification and limits

Run the TypeScript check, complete plugin test suite and BB plugin build before distribution. Automated coverage includes lifecycle/navigation, empty-input creation and cancellation, playback state, voice selection, startup-only briefing delivery, trace filtering and retention. Synthetic browser checks do not prove physical speaker output, Bluetooth routing, Safari behavior or background/lock-screen reliability.

Cached synthesis uses subscription allowance. Basic diagnostics omit conversation content; detailed diagnostics intentionally retain private text and timing locally. Neither mode records raw audio, SDP, credentials or reasoning. Do not include local databases, logs, transcripts or account files in a release.

## Public distribution

The GitHub repository is distributed as a developer preview with the dependency limits above. The pre-publication review checked all 127 historical source blobs for common credential patterns and sensitive file names and found no matches. Earlier documentation contains development workspace paths and opaque BB thread references; those are absent from the current documentation but remain in Git history. This bounded check is not a comprehensive security audit. The npm package, marketplace entry and customized BB core are separate distribution decisions.

Preserve the existing MIT license and attribution. There has been no trademark or name-availability review for Tandem.

## Changes proposed upstream

- Native voice on an existing Codex thread: [PR #7621](https://github.com/get-bb/bb/pull/7621). The PR exposes bounded startup context, voice selection and handoff instructions as caller configuration; it contains no Tandem prompts, briefing cache or built-in browser UI.
- Provider initialization before a first coding task: [PR #7620](https://github.com/get-bb/bb/pull/7620), tracking Tandem’s [issue #7619](https://github.com/get-bb/bb/issues/7619). This is related to Conductor’s pending-thread proposal but deliberately initializes the provider for an explicit voice-first action.

These contributions are open and ready for maintainer review; they are not merged features or a supported BB release. Both are based independently on upstream protocol 265 and propose 266; their final protocol numbers must be coordinated if both land. The current custom installation’s protocol 271 is a separate deployment history, not a requirement to copy into upstream.
