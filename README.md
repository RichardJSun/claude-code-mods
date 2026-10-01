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

It assumes the 1h cache TTL. On the 5m TTL the first ping misses and the mod stops.
