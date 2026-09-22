import { expect, test } from 'vite-plus/test';

import { compareReports, type BenchmarkReport } from './results.ts';

function report(samples: number[]): BenchmarkReport {
  return {
    schemaVersion: 1,
    workload: 'fixture-v1',
    revision: 'test-revision',
    environment: { node: 'v22.18.0', platform: 'linux', arch: 'x64', cpu: 'test', cpus: 4 },
    versions: {},
    results: [{ id: 'root/check/minimal', samples, configLoads: [] }],
  };
}

test('a single slow sample does not cause a timing regression', () => {
  const baseline = report([490, 495, 499, 500, 501, 505, 510]);
  const current = report([490, 495, 499, 500, 501, 505, 5000]);
  expect(compareReports(current, baseline).regressions).toEqual([]);
});

test('a sustained slowdown fails the timing comparison', () => {
  const baseline = report([490, 495, 499, 500, 501, 505, 510]);
  const current = report([640, 645, 649, 650, 651, 655, 660]);
  expect(compareReports(current, baseline).regressions).toHaveLength(1);
});

test('small absolute changes and overlapping distributions do not fail', () => {
  expect(
    compareReports(
      report([130, 130, 130, 130, 130, 130, 130]),
      report([100, 100, 100, 100, 100, 100, 100]),
    ).regressions,
  ).toEqual([]);
  expect(
    compareReports(
      report([490, 500, 550, 650, 750, 800, 900]),
      report([400, 450, 500, 500, 550, 700, 800]),
    ).regressions,
  ).toEqual([]);
});

test('different environments and workloads are explicitly not compared', () => {
  const baseline = report([100, 100, 100, 100, 100, 100, 100]);
  const current = report([500, 500, 500, 500, 500, 500, 500]);
  current.environment.node = 'v24.0.0';
  expect(compareReports(current, baseline).markdown).toContain('comparison skipped');
  current.environment = baseline.environment;
  current.workload = 'fixture-v2';
  expect(compareReports(current, baseline).markdown).toContain('comparison skipped');
});

test('invalid or incomplete baseline data cannot silently pass', () => {
  const current = report([500, 500, 500, 500, 500, 500, 500]);
  expect(() => compareReports(current, report([Number.NaN, 1, 1, 1, 1, 1, 1]))).toThrow(
    'positive, finite',
  );
  expect(() => compareReports(current, report([500]))).toThrow('seven samples');
  const baseline = report([500, 500, 500, 500, 500, 500, 500]);
  baseline.results = [];
  expect(() => compareReports(current, baseline)).toThrow('missing case');
});
