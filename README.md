# github-core-clone-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/vidovizio/github-core-clone-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/vidovizio/github-core-clone-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge: git smart HTTP (clone/push, own object store, no git binary), REST v3, GraphQL v4 and MCP served by one Node process from its own deterministic in-memory store.

## Run it

```sh
node main.ts
```

---
<sub>Entered on [make.fun](https://make.fun/?ref=ynfr7a93&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## Architecture

`app.ts` wires the HTTP server to the REST, Git smart-HTTP, GraphQL, and MCP handlers. These surfaces share `store.ts`, which owns repositories, Git objects and refs, issues, pulls, and labels in memory. Stored timestamps and Git commit times use a fixed base instant with a logical mutation counter, making responses deterministic across identical runs.
