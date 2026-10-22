# Measurements

Every figure here was produced by a command, given beside it. Re-run the command before quoting a
figure; a number nobody can reproduce is not evidence.

## Start-up cost of the schema

`graphql.gen.ts` constructs every type when `createSchema` runs, and a server runs it once, in
global scope: at module load on Node, and in a Worker's global scope on Workers, where it counts
against the platform's start-up limit of one second of CPU
(developers.cloudflare.com/workers/platform/limits/#worker-startup-time).

`test/socket/startup.test.ts` generates a spec of 30 resources with 5 operations each, 150
operations in all, every one declared in its `graphql.tsp`, and a link from each resource to the
next, 29 links. It compiles it with this emitter and measures two things.

- **Node.** `createSchema` timed with `performance.now()`, 25 times in one process. The first call
  includes the JIT warming; the median is the steady figure.
- **workerd.** `wrangler check startup`, which bundles the Worker as `wrangler deploy` would and
  writes a CPU profile of its global scope on the local workerd. The figure is the profile's active
  time, its samples not on `(idle)`, which is the "Active" figure wrangler prints, and the least of
  three profiles, since one local profile varies several-fold from run to run. The baseline is
  the same Worker with a one-field schema written by hand, so the difference is the generated
  schema's.

Reproduce:

```sh
pnpm build
pnpm vitest run --project system test/socket/startup.test.ts
cat test/socket/.out/startup/measurements.json
```

The two profiles, by hand, after the run above has generated the spec:

```sh
pnpm exec wrangler check startup --config test/socket/wrangler.baseline.jsonc --args="--config test/socket/wrangler.baseline.jsonc" --outfile test/socket/.out/startup/baseline.cpuprofile
pnpm exec wrangler check startup --config test/socket/wrangler.startup.jsonc --args="--config test/socket/wrangler.startup.jsonc" --outfile test/socket/.out/startup/schema.cpuprofile
```

`--args` hands the configuration to the `wrangler deploy --dry-run` that `check startup` builds the
bundle with, which is not given `--config` otherwise and refuses the package as a Hono project.

Measured on: 2026-10-14, with Node v22.22.3 and wrangler 4.149.0 on a local workerd.

| Node, 150 operations         | figure  |
| ---------------------------- | ------- |
| `createSchema`, first call   | 15.1 ms |
| `createSchema`, median of 25 | 4.8 ms  |

| workerd, global scope                  | active CPU | bundle     |
| -------------------------------------- | ---------- | ---------- |
| Yoga and a one-field schema (baseline) | 24.3 ms    | 612.9 KiB  |
| Yoga and the 150-operation schema      | 63.9 ms    | 1796.3 KiB |

### Budgets

The suite fails above 150 ms on Node (median) and 400 ms on workerd. The workerd budget is under
half the platform's limit because a local profile runs on a different CPU from the edge; the
platform reports the deployed figure as `startup_time_ms` when a Worker is uploaded.
