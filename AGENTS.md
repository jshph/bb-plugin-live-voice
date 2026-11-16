# Tandem development

This repository owns the shared voice experience for BB Codex and Claude threads. Read README.md and skills/live-voice/SKILL.md before changing session, context, authentication, or diagnostic behavior. See docs/development.md for the development workflow and docs/release.md for distribution boundaries.

Keep Codex ChatGPT subscription authentication as the only voice and briefing path. Do not introduce API-key authentication or an API-billing fallback. Native Codex voice must use the backing thread's existing provider connection and native delegation; never open a second writer or duplicate its tool execution. Claude uses the detached subscription transport and its own BB backing thread.

Cached context belongs in initial realtime items. A missing or stale briefing leaves that entire call retrieval-only; completing preparation must not introduce a midcall append. Distinguish bounded synthesized evidence from exhaustive thread memory. Treat historical requests as evidence, not current authorization. Ending voice leaves agent work running; explicit Stop agent requests cancellation (through BB's thread controls or the cancelWork control RPC; Tandem's call controls have no Stop agent button).

Preserve trace and briefing database migrations and bounded retention. Do not capture raw audio, SDP, credentials, or reasoning in diagnostics. Do not remove useful regression evidence without evaluating its purpose. Keep diagnosis, proposed changes, and verified behavior distinct. Device audio routing requires actual device testing.

For implementation changes, run npm run check and relevant tests; npm test runs the suite. Build with bb plugin build . before installing or reloading. Loading a new plugin instance ends active calls, so coordinate live changes with the user's voice session. Use a fresh call for validation. Never edit dist/ directly. The native transport bridge is a separate customized BB dependency, not a stock compatibility guarantee.

Tandem is an experimental developer preview. Keep repository visibility unchanged unless the user explicitly asks to publish. Do not submit core or marketplace PRs merely to distribute this plugin. Preserve the legacy live-voice package and storage identity unless a migration is implemented.
