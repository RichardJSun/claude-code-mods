# claude-code-mods

Claude Code mods, published as a plugin marketplace.

```
/plugin marketplace add RichardJSun/claude-code-mods
/plugin install cache-keepalive@richardjsun-mods
```

## cache-keepalive

When Claude ends a turn while background tasks are still running, the prompt cache can expire before the task's notification arrives. The next request then re-writes the whole context into the cache at 2× the input price.

This mod pings the cache with a one-line fork of the conversation every 50 minutes while the session waits. A cache read costs 0.025–0.1× input, so a ping costs a few percent of a re-write. Pings stop when:

- a new turn starts
- a ping misses the cache
- the pings have cost as much as one re-write would have

`/keepalive` pings now and reports the hit rate. The status line shows `armed`, `warm` or `stopped`.

### Limitations

The mod assumes the 1h cache TTL. It cannot read the TTL, so it infers the 5m TTL from overage, which switches a session to it. It does not arm while the 5-hour or 7-day rate-limit window is at 100% or more, and it stops if one crosses 100% during the wait. Mods cannot see model-scoped limits such as Fable's weekly one, so the mod ignores them. When such a limit runs out, the first ping misses and the mod stops. Rate-limit readings arrive with this session's own responses, so the mod may not see overage that other sessions cause during a wait. When a 5m TTL slips past the check, the first ping misses, pays for a full re-cache itself and saves nothing, and the mod stops.

### Compact on cap

The `compactOnCap` setting (off by default) compacts the conversation when the ping budget runs out, while the cache is still warm. It compacts only when the compaction's cost plus re-caching the summary is less than re-caching the whole context. The mod records the cost and summary size of each compaction it runs and uses them for the next decision. Compaction loses context detail, which is why it is off by default.

A background notification that arrives during compaction waits until compaction finishes, then starts its turn as usual.
