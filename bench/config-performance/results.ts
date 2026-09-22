export interface CaseResult {
  id: string;
  samples: number[];
  configLoads: { role: string; count: number }[];
}

export interface BenchmarkReport {
  schemaVersion: 1;
  workload: string;
  revision: string;
  environment: {
    node: string;
    platform: string;
    arch: string;
    cpu: string;
    cpus: number;
  };
  versions: Record<string, string>;
  results: CaseResult[];
}

export function percentile(samples: number[], fraction: number): number {
  if (samples.length === 0 || samples.some((sample) => !Number.isFinite(sample) || sample <= 0)) {
    throw new Error('Timings must be a nonempty array of positive, finite numbers');
  }
  const sorted = samples.toSorted((a, b) => a - b);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}

export function summarize(samples: number[]) {
  return {
    median: percentile(samples, 0.5),
    p25: percentile(samples, 0.25),
    p75: percentile(samples, 0.75),
    p95: percentile(samples, 0.95),
  };
}

export function compareReports(current: BenchmarkReport, baseline?: BenchmarkReport) {
  const regressions: string[] = [];
  let comparison = 'No baseline available; this run records the initial measurements.';
  const comparable =
    baseline !== undefined &&
    baseline.schemaVersion === current.schemaVersion &&
    baseline.workload === current.workload &&
    (Object.keys(current.environment) as (keyof BenchmarkReport['environment'])[]).every(
      (key) => baseline.environment[key] === current.environment[key],
    );

  if (baseline && !comparable) {
    comparison = 'Baseline environment or workload differs; timing comparison skipped.';
  }
  if (comparable) {
    comparison = `Compared with ${baseline.revision}.`;
  }
  const rows = current.results.map((result) => {
    const stats = summarize(result.samples);
    const previous = comparable
      ? baseline.results.find((item) => item.id === result.id)
      : undefined;
    let change = '—';
    if (comparable && !previous) {
      throw new Error(`Baseline is missing case ${result.id}`);
    }
    if (previous) {
      if (previous.samples.length < 7 || result.samples.length < 7) {
        throw new Error('A timing comparison requires at least seven samples per case');
      }
      const before = summarize(previous.samples);
      const delta = stats.median - before.median;
      const ratio = stats.median / before.median - 1;
      change = `${ratio >= 0 ? '+' : ''}${(ratio * 100).toFixed(1)}%`;
      // Require a substantial slowdown across the distribution, not one outlier.
      if (ratio > 0.2 && delta > 40 && stats.p25 > before.p75) {
        regressions.push(
          `${result.id}: ${before.median.toFixed(1)} → ${stats.median.toFixed(1)} ms (${change})`,
        );
      }
    }
    const loads =
      result.configLoads.map(({ role, count }) => `${role}: ${count}`).join(', ') || '0';
    return `| ${result.id} | ${stats.median.toFixed(1)} | ${stats.p95.toFixed(1)} | ${change} | ${loads} |`;
  });
  const markdown = [
    '## Config performance',
    '',
    comparison,
    '',
    `Revision: \`${current.revision}\`. Node ${current.environment.node}; ${current.environment.platform}/${current.environment.arch}; ${current.environment.cpu}.`,
    '',
    '| Case | Median (ms) | p95 (ms) | Median change | Config evaluations (separate probe) |',
    '| --- | ---: | ---: | ---: | --- |',
    ...rows,
    '',
    'Fresh processes, warm filesystem and Node compile caches. Config logging is disabled during timing.',
    'A timing regression requires >20% and >40 ms median growth, with current p25 above baseline p75.',
    '',
    ...regressions.map((regression) => `- Regression: ${regression}`),
    '',
  ].join('\n');
  return { regressions, markdown };
}
