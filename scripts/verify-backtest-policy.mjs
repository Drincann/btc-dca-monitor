import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  classifyBacktestedSignal,
  isPrimaryBottomSignal,
  isStrongFourHourDropSignal,
  primarySignalSummary,
  summarizeParameterSensitivity,
} from '../shared/decision-policy.mjs';

const report = JSON.parse(await readFile(new URL('../reports/backtest-report.json', import.meta.url), 'utf8'));
const markdown = await readFile(new URL('../reports/backtest-report.md', import.meta.url), 'utf8');
const repoRoot = new URL('../', import.meta.url);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function topSignals() {
  return [...report.signals.results].sort((a, b) => b.score - a.score).slice(0, 4);
}

function verifyReportShape() {
  assert(report.signals.results.length === 24, `expected 24 signal results, got ${report.signals.results.length}`);
  assert(report.strategy.rows.length === 4, `expected 4 strategy rows, got ${report.strategy.rows.length}`);
  assert(report.regimes.length >= 3, `expected at least 3 regime groups, got ${report.regimes.length}`);
  assert(report.parameterSensitivity.length === 2, `expected 2 parameter sensitivity groups, got ${report.parameterSensitivity.length}`);
  assert(report.walkForward.length === 6, `expected 6 walk-forward rows, got ${report.walkForward.length}`);
}

function verifyPolicyClassification() {
  const ranked = topSignals();
  const expected = [
    ['1d', 'RSI超卖反转', '可作为下一笔买入确认'],
    ['4h', '短跌过度反转', '需多周期确认'],
    ['4h', 'RSI超卖反转', '需多周期确认'],
    ['4h', '布林下轨放量收回', '需多周期确认'],
  ];

  expected.forEach(([interval, name, finding], index) => {
    const actual = ranked[index];
    assert(actual.interval === interval && actual.name === name, `rank ${index + 1} expected ${interval} ${name}, got ${actual.interval} ${actual.name}`);
    assert(classifyBacktestedSignal(actual) === finding, `rank ${index + 1} expected finding ${finding}, got ${classifyBacktestedSignal(actual)}`);
    assert(actual.finding === finding, `report finding drifted for ${actual.interval} ${actual.name}`);
  });
}

function verifyExecutionPolicy() {
  assert(
    isPrimaryBottomSignal({
      label: '1D',
      signal: { action: 'buy', signalName: 'RSI 超卖反转' },
    }),
    '1D RSI buy should be primary',
  );
  assert(
    !isPrimaryBottomSignal({
      label: '4H',
      signal: { action: 'buy', signalName: '短跌过度反转' },
    }),
    '4H short-drop buy should not be primary after walk-forward validation',
  );
  assert(
    !isPrimaryBottomSignal({
      label: '4H',
      signal: { action: 'buy', signalName: '布林下轨收回' },
    }),
    '4H bollinger buy should not be primary',
  );
  assert(
    isStrongFourHourDropSignal({
      label: '4H',
      signal: { action: 'buy', signalName: '短跌过度反转', sevenDayDrawdown: -0.101 },
    }),
    '4H short-drop <= -10% should be strong confirmation',
  );
  assert(
    !isStrongFourHourDropSignal({
      label: '4H',
      signal: { action: 'buy', signalName: '短跌过度反转', sevenDayDrawdown: -0.08 },
    }),
    '4H short-drop -8% should not be strong confirmation',
  );
}

function verifyMarkdownConsistency() {
  assert(markdown.includes(primarySignalSummary()), 'markdown missing primary signal summary');
  assert(markdown.includes(summarizeParameterSensitivity(report.parameterSensitivity)), 'markdown missing parameter sensitivity summary');
  assert(markdown.includes('## 样本外验证'), 'markdown missing walk-forward section');
  assert(!/68000|68,000|supportLevel|supportReclaim/.test(markdown), 'markdown contains fixed-price signal residue');
}

function verifyWalkForward() {
  const adoptedSignals = new Set(['1d RSI超卖反转', '4h 短跌过度反转']);
  const groups = new Map();

  report.walkForward.forEach((row) => {
    const key = `${row.interval} ${row.name}`;
    assert(adoptedSignals.has(key), `unexpected walk-forward signal ${key}`);
    assert(row.trainSignals > 0, `${key} ${row.splitDate} has no training signals`);
    assert(row.testSignals >= 5, `${key} ${row.splitDate} has too few out-of-sample signals`);
    if (row.role === '主信号') {
      assert(row.test30DayAverage > 0, `${key} ${row.splitDate} has non-positive out-of-sample 30d average`);
      assert(row.test30DayP25 > -0.08, `${key} ${row.splitDate} has weak out-of-sample downside`);
      assert(row.passed, `${key} ${row.splitDate} primary signal failed walk-forward validation`);
    }
    groups.set(key, (groups.get(key) ?? 0) + 1);
  });

  adoptedSignals.forEach((key) => {
    assert(groups.get(key) === 3, `${key} should have 3 walk-forward splits`);
  });

  const confirmationRows = report.walkForward.filter((row) => row.role === '确认信号');
  assert(confirmationRows.filter((row) => row.passed).length >= 2, 'confirmation signal should pass at least 2 of 3 walk-forward splits');
}

async function verifyNoFixedPriceSignalResidue() {
  const filesToScan = [
    'src/main.tsx',
    'shared/market-signals.mjs',
    'shared/accumulation-strategies.mjs',
    'shared/decision-policy.mjs',
    'scripts/generate-backtest-report.mjs',
    'README.md',
    'reports/backtest-report.md',
  ];
  const fixedPriceResidue = /\b(?:52K|56K|59K|64K|68K|72K|76K)\b|68000|68,000|72000|72,000|supportLevel|supportReclaim|关键位|价格区间/;

  for (const file of filesToScan) {
    const content = await readFile(new URL(join('./', file), repoRoot), 'utf8');
    assert(!fixedPriceResidue.test(content), `${file} contains fixed-price signal residue`);
  }
}

verifyReportShape();
verifyPolicyClassification();
verifyExecutionPolicy();
verifyMarkdownConsistency();
verifyWalkForward();
await verifyNoFixedPriceSignalResidue();

console.log('Backtest policy verification passed.');
