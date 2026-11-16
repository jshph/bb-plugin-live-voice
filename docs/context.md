# Thread background and cached briefing

## How it works

Cached briefing is an experimental option. The plugin synthesizes a compact reference from recent user messages, root assistant answers, and completed tool results, using an isolated Codex session authenticated with your ChatGPT subscription. The JSON reference contains goals, decisions, verified findings with event pointers, and unresolved questions. It is historical evidence, not authorization to resume old work.

A fresh briefing enters the initial realtime context before audio connects, for both Codex and Claude. A missing, stale, busy, or failed preparation starts retrieval-only for that entire call. Preparation never delays startup on model generation, and a result that finishes during a call is reserved for the next call. No background is appended after connection. With Cached briefing off, or without a ready briefing, both Codex and Claude calls are told that no briefing is supplied and to retrieve missing facts through the backing agent. This includes BB's older native bridge, which would otherwise add its own deferred thread history. The backing agent remains available for focused evidence retrieval. Initial context is not a guarantee of model attention or silence.

Cached briefing defaults to off. Enable the **Cached briefing** toggle in plugin settings or use `bb plugin config live-voice set cachedBriefing true`, then start a fresh call. Threads used for voice with Cached briefing enabled, or explicitly prepared threads, are watched; watched threads refresh after backing turns become idle. Active threads invalidate pending/stored briefings. Synthesis uses the latest 12 user requests and 100 completed items after the last context clear, up to 60,000 source characters, clipping individual items at 6,000 characters. Earlier evidence may be absent. Compiler output is validated, includes only supplied event pointers, and is capped at 3,000 JSON characters (4,000 including framing). It can still omit or misinterpret a fact; ask the backing agent when uncertain.

Briefings are private local plugin data, retained for up to 20 watched threads and seven days. A briefing is usable for 24 hours only while its thread revision matches. Synthesis consumes Codex subscription allowance, runs one job at a time, and uses a 90-second deadline with no API-key fallback. The compiler is instructed to treat source as quoted data, with shell, web, and multi-agent features disabled; observed tool execution rejects preparation. Failed preparation falls back to retrieval.

Cached native Codex calls require the customized startup-briefing bridge (host daemon protocol 269); the bridge is additional to the original transport requirement. Codex delegation still uses the original provider connection.

Delegated instructions and quoted context are agent-only; chat shows new spoken words or a labeled voice-model task. Instructions are sent once per call after provider acceptance, and later requests contain only new or changed spoken turns. Grouped transcripts preserve corrections, continuations, and explicit incompleteness. Exact echoes of backing answers are omitted; paraphrases are conversational reference, not independent evidence. Up to 350 ms is allowed for a user turn to finish before delegation.

Streaming makes available text reach voice sooner; it cannot make the backing model’s research itself faster. Progress and partial findings must retain their qualifications. Existing historical messages are not rewritten.


## Briefing controls

All three RPCs take `{ "threadId": "thr_..." }` through `--input-file`:

```sh
bb plugin rpc call live-voice briefingStatus --input-file /tmp/voice-thread.json --json
bb plugin rpc call live-voice prepareBriefing --input-file /tmp/voice-thread.json --json
bb plugin rpc call live-voice forgetBriefing --input-file /tmp/voice-thread.json --json
```

`briefingStatus` returns `missing`, `busy`, `preparing`, `ready`, `stale`, or `error`; only ready responses include the JSON text. `prepareBriefing` watches the thread and queues preparation when idle without waiting for synthesis. It can explicitly prepare a cache even while background is off. `forgetBriefing` deletes the cache and watch. Turning Cached briefing off cancels queued/in-progress automatic preparation; existing calls keep their startup policy. `context.startup` records attempted startup cache metadata (and the exact reference only in detailed mode). The `start` RPC returns `briefing: ready | lookup` in cached mode. Turn Cached briefing off to restore the baseline for new calls.
