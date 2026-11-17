> **Deprecated — development moved.** This repository has been replaced by [jshph/bb-extensions](https://github.com/jshph/bb-extensions), with the maintained plugin in [`plugins/tandem`](https://github.com/jshph/bb-extensions/tree/main/plugins/tandem). Use the new repository for updates and issues. This repository remains available for history, existing install URLs, and outstanding pull-request review. It has not been archived.

# Tandem

Talk with the coding agent in your BB thread. Tandem uses Codex subscription voice for the conversation while **Codex or Claude** does the coding work.

For example, open a Claude thread, talk through a change, and hear its findings as it works. Your Claude provider still runs the task with its existing tools and permissions; the voice conversation uses Codex signed in with ChatGPT. You can use the same controls in a Codex thread.

Tandem is an experimental developer preview. Native Codex voice currently needs changes in BB that are being proposed upstream. Installing the plugin alone does not add those changes. See [compatibility and release status](docs/release.md).

## Using Tandem

- Press the waveform beside dictation to start a conversation. While connected, it pulses gently and glows when assistant playback is detected.
- Mute controls your microphone. The red hang-up button ends voice; submitted coding work can continue. Use BB’s thread controls to cancel agent work.
- Navigate freely within BB. The call stays attached to its original thread, with a floating dial that lets you return, mute or hang up. Starting voice elsewhere offers an explicit switch.
- Start from New thread to create a thread using your selected project, environment and agent settings, then connect voice. This sends no placeholder coding request and leaves your draft alone. It requires BB’s initialized-thread support.

Tool approvals remain in BB. Closing or reloading the page ends voice. A later call is a fresh conversation; it does not resume the previous audio conversation. Other tasks already running in a Claude thread are not silently taken over by voice.

## Why a plugin?

Tandem provides one conversation experience across coding agents. It decides how spoken corrections become requests, how follow-ups reach work already running, and how results and thread background reach the voice conversation. Keeping that experience in a plugin lets it evolve independently of BB releases and avoids repeating the controls in each coding provider.

BB still owns coding sessions, tool permissions and provider connections. Native Codex voice needs a small operation on that existing connection; Tandem should not open a second writer or repeat Codex’s native handoffs. Claude uses BB’s normal thread APIs to receive work and return results.

The same separation could support a built-in BB voice interface later. A plugin is a way to maintain and distribute this experience, not a technical requirement for customization. See [the explanation for BB maintainers](docs/maintainers.md) for the proposed core changes and their limits.

## What you need

- A compatible BB installation with the SDK features Tandem uses. This version builds against Plugin SDK 0.6.144.
- The official Codex CLI on the BB server, signed in with ChatGPT. Codex 0.160.1 has been exercised. There is no API-key or API-billing fallback.
- For Claude threads, your existing Claude provider setup. Voice uses Codex’s subscription; coding work continues through Claude with its existing authentication and billing.
- For native Codex calls and voice from New thread, the additional BB capabilities described in [release status](docs/release.md). General compatibility with unmodified BB releases is not established.

Automated tests use simulated browser audio, Codex and BB services; they do not establish live transport compatibility. Physical microphone/speaker routing, Bluetooth, Safari and background/lock-screen behavior need further testing. The Codex realtime protocol is experimental and can require adapter updates.

## Settings

Open Tandem’s plugin settings:

- **Voice:** choose a voice for new calls, or keep Codex’s default. Changing it does not interrupt an existing call.
- **Cached briefing:** optionally prepare a short reference from recent thread activity before a call starts. If no current briefing is ready, that entire call uses the coding agent to look up missing details. This is bounded background, not complete thread memory. Preparation uses Codex subscription allowance.
- **Diagnostics:** Basic saves compact troubleshooting metadata. Detailed also saves private conversation text and timing locally; enable it only when needed for an investigation.
- **Codex executable:** select the official CLI on the BB server if its normal command points to another account or wrapper.

Cached briefing defaults to off. Settings apply to new calls. See [thread background](docs/context.md) and [troubleshooting and data retention](docs/diagnostics.md) for details.

## Install and develop

Tandem is an experimental source preview. The native Codex path still requires the BB support described above; public source availability does not establish stock BB compatibility. To build from source:

```sh
git clone https://github.com/jshph/bb-plugin-live-voice.git
cd bb-plugin-live-voice
npm ci --include=dev
npm run check
npm test
bb plugin build .
bb plugin install .
```

For an existing local installation, rebuild and run `bb plugin reload live-voice`. Reloading ends active voice calls; validate with a fresh call.

The display name is **Tandem**. Its package name stays `bb-plugin-live-voice` and plugin ID stays `live-voice` so existing settings, briefing cache and traces remain available. CLI examples therefore use that ID:

```sh
bb plugin config live-voice set cachedBriefing true
bb plugin rpc inspect live-voice
```

See [development](docs/development.md), [maintainer context](docs/maintainers.md), and [release status](docs/release.md). Distributed under the [MIT license](LICENSE), preserving the existing attribution.
