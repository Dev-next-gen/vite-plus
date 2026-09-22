This benchmark tracks the config-loading costs described in [#2698](https://github.com/voidzero-dev/vite-plus/issues/2698). It runs the checkout's built CLI without modifying its code or dependencies.

Build the checkout as described in [CONTRIBUTING.md](../../CONTRIBUTING.md), then run on Linux or macOS:

```sh
node bench/config-performance/run.ts
```

Results go to `tmp/config-performance/results.json` and `summary.md`. To compare with an earlier result on the same machine and Node version:

```sh
node bench/config-performance/run.ts --baseline previous-results.json
```

Use `--samples 2 --warmup 1` for a smoke run. A timing comparison requires at least seven samples. Defaults are 15 samples and three warmup rounds.

The cases cover root and package-directory `vp check --fix`, missing and minimal configs, `defineConfig`, root `lint`/`fmt` blocks, standalone tools, and `vp staged` with a check or a no-op task. Each sample starts a fresh process. Cases rotate between rounds. File and Git preparation happen outside the timed interval, and each sample receives the same three unformatted TypeScript files. Staged samples verify the formatted Git index. Command errors and timeouts fail the benchmark.

Config evaluations are measured in separate runs. Synchronous log writes do not affect the timing samples. The current ceilings are four evaluations for a root check, seven for a package check, and five for staged checks. Each Oxc child may evaluate its config at most once. These ceilings retain the current package-directory overhead until a separate optimization reduces it. Reduce the relevant ceiling with that optimization.

The benchmark uses temporary projects outside the checkout so ancestor config discovery cannot find the repository's config. It runs the same Node executable in staged tasks and tool children. It uses a separate Node compile-cache directory and removes fixtures after completion. Warmups make this a measurement of fresh-process startup with warm filesystem and compile caches, not a cold-disk benchmark.

The [Config Performance workflow](../../.github/workflows/config-performance.yml) runs on relevant PR updates, relevant pushes to `main`, daily, and on manual dispatch. Draft PRs run normally. The daily schedule becomes active after the workflow reaches `main`.

CI retains JSON samples and Markdown reports for 90 days. It compares with the latest available successful `main` run. Before the workflow reaches `main`, PR updates use an earlier successful run of the same branch when available. The first run records a baseline. Workload, Node version, operating system, architecture, CPU model, and CPU count must match for a timing comparison; a mismatch is reported explicitly.

A timing regression fails CI when all three conditions hold:

- The median grows by more than 20%.
- The median grows by more than 40 ms.
- The current 25th percentile exceeds the baseline 75th percentile.

This catches substantial, sustained regressions while tolerating isolated slow samples. It does not prove that smaller changes are harmless. Review the medians, p95 values, raw samples, and config counts when changing config resolution. CPU load and runner image changes can still affect results. Config-count ceilings apply even when timing results are not comparable.

The workload hash changes with the fixture or case definitions, so those changes establish a new timing baseline. Tool versions are recorded but are not part of the compatibility check: dependency updates must remain visible in the comparison.
