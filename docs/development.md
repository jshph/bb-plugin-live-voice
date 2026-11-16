# Tandem development

Develop in a dedicated checkout registered as the Tandem BB project. The package name remains `bb-plugin-live-voice`; BB derives the stable plugin ID `live-voice` from it. Keep this identity when changing branding so settings, briefing cache and traces remain available.

```sh
npm ci --include=dev
npm run check
npm test
bb plugin build .
bb plugin install .
```

For an existing local installation, rebuild and use `bb plugin reload live-voice`. Reloading or reinstalling ends active voice calls; coordinate with the user and validate in a fresh call. Do not edit generated `dist/` files.

## Source layout

The browser and server parts of the plugin are built separately, so the source keeps them apart:

- `src/app/` holds the voice controls, audio handling and styles that run in the browser.
- `src/server/` holds what runs on the BB server: call sessions, native Codex voice, the Claude voice connection and request handling, the model-facing instructions in `prompts.ts`, and diagnostics storage.
- `src/server/briefing/` prepares, stores and checks cached briefings.
- `src/shared/` holds request formats and helpers that both sides need.

Tests sit beside the code they cover. `src/boundaries.test.ts` fails if browser code imports server code, or if shared code imports either side. The browser may use shared request formats only as types. `skills/` stays at the repository root because the BB build copies it from there.

## Before changing behavior

Read README.md and skills/live-voice/SKILL.md before changing session, context, authentication or diagnostics. Preserve the regression evidence for startup-only cached context, subscription authentication, backing-thread delegation and call lifecycle. Device routing requires actual device tests.

The customized native bridge lives in the BB core repository at `plugins/provider-codex/src/bridge/voice.ts`. Core changes follow that repository’s instructions and deployment workflow. A plugin-only change normally needs no core deployment. See release.md for the required capabilities and limits of the current evidence.

Keep deployment logs, local workspace paths, thread identifiers, account details and private transcripts outside the public source tree. The maintainer’s original development notes are retained locally rather than shipped as public documentation.
