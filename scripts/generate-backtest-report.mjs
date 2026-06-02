import { mkdir, writeFile } from 'node:fs/promises';
import { backtestMarketConfig, candleDateRange, fetchBacktestCandles } from './market-data.mjs';
import { accumulationStrategies, evaluateAccumulationStrategies } from '../shared/accumulation-strategies.mjs';
import {
  classifyBacktestedSignal,
  confirmationSignalRules,
  primarySignalRules,
  primarySignalSummary,
  summarizeParameterSensitivity,
} from '../shared/decision-policy.mjs';
import {
  average,
  calculateRsiSeries,
  closePosition,
  cooldownSignalIndexes,
  evaluateSignalCandidate,
  percentile,
  rolling,
  scoreSignalResult,
  signalCandidateDefinitions,
  signalHorizons,
  trendAllowsSignal,
} from '../shared/market-signals.mjs';

const targetBtc = 0.83223;
const windowDays = 150;
const reportsDir = new URL('../reports/', import.meta.url);

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toFixed(0) : '-';
}

function horizon(result, days) {
  return result.horizonStats.find((item) => item.days === days);
}

function evaluateSignalCandidateSegment(candles, candidate, barsPerDay, fromTime, toTime, horizons = signalHorizons) {
  const signalIndexes = cooldownSignalIndexes(candles, candidate).filter((index) => {
    const time = candles[index]?.time ?? 0;
    return time >= fromTime && time < toTime;
  });

  const horizonStats = horizons.map((days) => {
    const bars = Math.max(1, Math.round(days * barsPerDay));
    const returns = signalIndexes
      .map((index) => (candles[index + bars] ? (candles[index + bars].close - candles[index].close) / candles[index].close : null))
      .filter((value) => value !== null);

    return {
      days,
      samples: returns.length,
      winRate: returns.length > 0 ? returns.filter((value) => value > 0).length / returns.length : 0,
      averageReturn: average(returns),
      medianReturn: percentile(returns, 0.5),
      p25Return: percentile(returns, 0.25),
    };
  });

  return {
    signals: signalIndexes.length,
    horizonStats,
  };
}

function evaluateSignalStability(candles, candidate, barsPerDay, horizonDays = 30) {
  const bars = Math.max(1, Math.round(horizonDays * barsPerDay));
  const signals = cooldownSignalIndexes(candles, candidate);
  const returnsByYear = new Map();

  signals.forEach((index) => {
    const entry = candles[index];
    const exit = candles[index + bars];
    if (!entry || !exit) {
      return;
    }

    const year = new Date(entry.time).getUTCFullYear();
    if (!returnsByYear.has(year)) {
      returnsByYear.set(year, []);
    }
    returnsByYear.get(year).push((exit.close - entry.close) / entry.close);
  });

  const yearly = Array.from(returnsByYear.entries())
    .sort(([a], [b]) => a - b)
    .map(([year, returns]) => ({
      year,
      samples: returns.length,
      averageReturn: average(returns),
      winRate: returns.filter((value) => value > 0).length / Math.max(1, returns.length),
    }));
  const validYears = yearly.filter((row) => row.samples >= 2);
  const positiveYears = validYears.filter((row) => row.averageReturn > 0);

  return {
    horizonDays,
    yearly,
    validYears: validYears.length,
    positiveYears: positiveYears.length,
    positiveYearRate: validYears.length > 0 ? positiveYears.length / validYears.length : 0,
    worstYearReturn: validYears.length > 0 ? Math.min(...validYears.map((row) => row.averageReturn)) : 0,
  };
}

function evaluateCustomSignal(candles, signal, barsPerDay, minBars = 45, cooldownBars = 5) {
  const signals = [];
  let lastSignalIndex = -cooldownBars - 1;

  for (let index = minBars; index < candles.length - 31; index += 1) {
    if (index - lastSignalIndex <= cooldownBars) {
      continue;
    }
    if (signal(index)) {
      signals.push(index);
      lastSignalIndex = index;
    }
  }

  const stats = signalHorizons.map((days) => {
    const bars = Math.max(1, Math.round(days * barsPerDay));
    const returns = signals
      .map((index) => (candles[index + bars] ? (candles[index + bars].close - candles[index].close) / candles[index].close : null))
      .filter((value) => value !== null);
    return {
      days,
      samples: returns.length,
      winRate: returns.length > 0 ? returns.filter((value) => value > 0).length / returns.length : 0,
      averageReturn: average(returns),
      p25Return: percentile(returns, 0.25),
    };
  });

  const h14 = stats.find((item) => item.days === 14);
  const h30 = stats.find((item) => item.days === 30);
  const score =
    h14 && h30 && h14.samples >= 8
      ? h14.averageReturn * 0.45 + h30.averageReturn * 0.35 + (h14.winRate - 0.5) * 0.12 + h14.p25Return * 0.08
      : -Infinity;

  return {
    signals: signals.length,
    score,
    horizonStats: stats,
  };
}

function evaluateParameterSensitivity(candlesByInterval) {
  const dailyCandles = candlesByInterval['1d'];
  const fourHourCandles = candlesByInterval['4h'];
  const dailyRsi = calculateRsiSeries(dailyCandles, 14);
  const fourHourRsi = calculateRsiSeries(fourHourCandles, 14);
  const dailyRows = [28, 30, 32, 34, 36].map((rsiThreshold) => {
    const result = evaluateCustomSignal(
      dailyCandles,
      (index) => {
        const candle = dailyCandles[index];
        const previous = dailyCandles[index - 1];
        const rsi14 = dailyRsi[index];
        const previousRsi = dailyRsi[index - 1];
        const last20 = rolling(dailyCandles, index, 20);
        const volumeRatio = candle.volume / Math.max(1, average(last20.map((item) => item.volume)));
        return (
          trendAllowsSignal(dailyCandles, index) &&
          previousRsi !== null &&
          rsi14 !== null &&
          previousRsi <= rsiThreshold &&
          rsi14 > previousRsi &&
          candle.close > previous.close &&
          volumeRatio >= 1.05
        );
      },
      backtestMarketConfig['1d'].barsPerDay,
    );
    return {
      signal: '1D RSI超卖反转',
      rsiThreshold,
      ...result,
    };
  });

  const fourHourRows = [];
  [-0.06, -0.08, -0.1, -0.12].forEach((drawdownThreshold) => {
    [0.55, 0.58, 0.62].forEach((recoveryThreshold) => {
      const result = evaluateCustomSignal(
        fourHourCandles,
        (index) => {
          const candle = fourHourCandles[index];
          const previous = fourHourCandles[index - 1];
          const recentSeven = rolling(fourHourCandles, index, 7);
          const localHigh = Math.max(...recentSeven.map((item) => item.high));
          const shortDrawdown = candle.low / localHigh - 1;
          const rsi14 = fourHourRsi[index];
          const previousRsi = fourHourRsi[index - 1];
          return (
            trendAllowsSignal(fourHourCandles, index) &&
            shortDrawdown <= drawdownThreshold &&
            previousRsi !== null &&
            rsi14 !== null &&
            rsi14 > previousRsi &&
            candle.close > previous.close &&
            closePosition(candle) >= recoveryThreshold
          );
        },
        backtestMarketConfig['4h'].barsPerDay,
      );
      fourHourRows.push({
        signal: '4H 短跌过度反转',
        drawdownThreshold,
        recoveryThreshold,
        ...result,
      });
    });
  });

  return [
    {
      signal: '1D RSI超卖反转',
      tested: 'RSI 阈值 28/30/32/34/36',
      rows: dailyRows,
      best: dailyRows.reduce((winner, row) => (row.score > winner.score ? row : winner), dailyRows[0]),
      baseline: dailyRows.find((row) => row.rsiThreshold === 32),
    },
    {
      signal: '4H 短跌过度反转',
      tested: '7根K回撤 6/8/10/12%，收回位置 55/58/62%',
      rows: fourHourRows,
      best: fourHourRows.reduce((winner, row) => (row.score > winner.score ? row : winner), fourHourRows[0]),
      baseline: fourHourRows.find((row) => row.drawdownThreshold === -0.08 && row.recoveryThreshold === 0.58),
    },
  ];
}

function classifyRegime(candles, startIndex) {
  if (startIndex < 180 || startIndex + windowDays >= candles.length) {
    return null;
  }

  const last180 = rolling(candles, startIndex, 180);
  const last90 = rolling(candles, startIndex, 90);
  const last30 = rolling(candles, startIndex, 30);
  const high180 = Math.max(...last180.map((candle) => candle.high));
  const drawdown = candles[startIndex].close / high180 - 1;
  const ma30 = average(last30.map((candle) => candle.close));
  const ma90 = average(last90.map((candle) => candle.close));
  const slopeCooling = ma30 < ma90 * 1.02;

  if (drawdown <= -0.35 && slopeCooling) {
    return 'deepBear';
  }
  if (drawdown <= -0.20 && slopeCooling) {
    return 'bearPullback';
  }
  if (drawdown <= -0.12) {
    return 'ordinaryPullback';
  }
  return null;
}

function evaluateRegimes(candles) {
  const groups = new Map();

  for (let startIndex = 200; startIndex + windowDays < candles.length; startIndex += 14) {
    const regime = classifyRegime(candles, startIndex);
    if (!regime) {
      continue;
    }

    const windowCandles = candles.slice(startIndex, startIndex + windowDays);
    if (!groups.has(regime)) {
      groups.set(regime, []);
    }

    for (const strategy of accumulationStrategies) {
      groups.get(regime).push({
        regime,
        strategy: strategy.name,
        ...strategy.run(candles, startIndex, windowCandles, targetBtc),
      });
    }
  }

  return Array.from(groups.entries()).map(([regime, rows]) => {
    const strategyNames = [...new Set(rows.map((row) => row.strategy))];
    return {
      regime,
      rows: strategyNames.map((strategyName) => {
        const strategyRows = rows.filter((row) => row.strategy === strategyName);
        const efficiencies = strategyRows.map((row) => row.efficiency);
        const entries = strategyRows.map((row) => row.averagePrice);
        return {
          name: strategyName,
          samples: strategyRows.length,
          averageEntry: average(entries),
          averageEfficiency: average(efficiencies),
          p25Efficiency: percentile(efficiencies, 0.25),
          completionRate: strategyRows.filter((row) => row.completed).length / Math.max(1, strategyRows.length),
        };
      }),
    };
  });
}

function evaluateWalkForward(candlesByInterval) {
  const splitDates = ['2023-01-01', '2024-01-01', '2025-01-01'];
  const adoptedSignals = [
    ...primarySignalRules.map((rule) => ({ ...rule, role: '主信号' })),
    ...confirmationSignalRules.map((rule) => ({ ...rule, role: '确认信号' })),
  ]
    .map((rule) => ({
      interval: rule.interval,
      name: rule.reportName,
      role: rule.role,
      candidate: signalCandidateDefinitions.find((candidate) => candidate.name === rule.reportName),
    }))
    .filter((item) => item.candidate);

  return adoptedSignals.flatMap((item) => {
    const candles = candlesByInterval[item.interval];
    const barsPerDay = backtestMarketConfig[item.interval].barsPerDay;

    return splitDates.map((splitDate) => {
      const splitTime = Date.parse(`${splitDate}T00:00:00Z`);
      const train = evaluateSignalCandidateSegment(candles, item.candidate, barsPerDay, Number.NEGATIVE_INFINITY, splitTime);
      const test = evaluateSignalCandidateSegment(candles, item.candidate, barsPerDay, splitTime, Number.POSITIVE_INFINITY);
      const test30 = horizon(test, 30);
      const train30 = horizon(train, 30);

      return {
        interval: item.interval,
        name: item.name,
        role: item.role,
        splitDate,
        trainSignals: train.signals,
        train30DayAverage: train30?.averageReturn ?? 0,
        testSignals: test.signals,
        test30DayAverage: test30?.averageReturn ?? 0,
        test30DayWinRate: test30?.winRate ?? 0,
        test30DayP25: test30?.p25Return ?? 0,
        passed: (test30?.samples ?? 0) >= 5 && (test30?.averageReturn ?? 0) > 0 && (test30?.p25Return ?? 0) > -0.08,
      };
    });
  });
}

function strategyFinding(strategyBacktest) {
  const best = strategyBacktest.rows.reduce((winner, row) => (row.averageEfficiency > winner.averageEfficiency ? row : winner), strategyBacktest.rows[0]);
  return `当前样本下「${best.name}」平均效率最高，但差距不大；策略执行仍应优先保证完成率和现金纪律。`;
}

function buildMarkdown(report) {
  const rankedSignals = [...report.signals.results].sort((a, b) => b.score - a.score).slice(0, 10);
  const lines = [
    '# BTC 抄底信号回测报告',
    '',
    `生成时间：${report.generatedAt}`,
    `样本范围：4H ${report.signals.ranges['4h'].start} 至 ${report.signals.ranges['4h'].end}；1D ${report.signals.ranges['1d'].start} 至 ${report.signals.ranges['1d'].end}；1W ${report.signals.ranges['1w'].start} 至 ${report.signals.ranges['1w'].end}`,
    '',
    '## 核心结论',
    '',
    '- 不使用固定价格作为指标输入；所有信号都来自相对回撤、RSI、布林、K 线收回和成交量变化。',
    '- 信号适合判断“下一笔是否可以执行”，目前证据不支持完全替代定投。',
    `- ${primarySignalSummary()}`,
    `- 参数敏感性：${summarizeParameterSensitivity(report.parameterSensitivity)}`,
    `- ${strategyFinding(report.strategy)}`,
    '',
    '## 候选信号排名',
    '',
    '| 排名 | 周期 | 信号 | 触发次数 | 14天均值 | 14天胜率 | 30天均值 | 正收益年份 | 最差年份 | 结论 |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];

  rankedSignals.forEach((result, index) => {
    const h14 = horizon(result, 14);
    const h30 = horizon(result, 30);
    const stability = result.stability;
    lines.push(
      `| ${index + 1} | ${result.interval} | ${result.name} | ${result.signals} | ${formatPercent(h14?.averageReturn ?? 0)} | ${formatPercent(h14?.winRate ?? 0)} | ${formatPercent(h30?.averageReturn ?? 0)} | ${stability ? `${stability.positiveYears}/${stability.validYears}` : '-'} | ${formatPercent(stability?.worstYearReturn ?? 0)} | ${classifyBacktestedSignal(result)} |`,
    );
  });

  lines.push(
    '',
    '## 稳健性说明',
    '',
    '- “正收益年份”按 30 天收益统计，只有当某年同一信号至少触发 2 次才计入。',
    '- 排名靠前但正收益年份不足的信号，只能作为辅助观察，不能单独触发加仓。',
    '- 样本外验证按时间切分，只看切分日之后的新样本，防止参数只是在早期行情里碰巧有效。',
    '',
  );

  lines.push(
    '',
    '## 样本外验证',
    '',
    '口径：验证最终采用的主信号和确认信号；切分日前为训练期，切分日后为样本外。表内收益均为触发后 30 天收益。',
    '',
    '| 信号 | 角色 | 切分日 | 训练期触发 | 训练期均值 | 样本外触发 | 样本外均值 | 样本外胜率 | 样本外下四分位 | 结论 |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  );
  report.walkForward.forEach((row) => {
    lines.push(
      `| ${row.interval} ${row.name} | ${row.role} | ${row.splitDate} | ${row.trainSignals} | ${formatPercent(row.train30DayAverage)} | ${row.testSignals} | ${formatPercent(row.test30DayAverage)} | ${formatPercent(row.test30DayWinRate)} | ${formatPercent(row.test30DayP25)} | ${row.passed ? '通过' : '谨慎'} |`,
    );
  });

  lines.push('', '## 参数敏感性', '');
  report.parameterSensitivity.forEach((item) => {
    lines.push(`### ${item.signal}`, '', `测试范围：${item.tested}`, '');
    if (item.signal === '1D RSI超卖反转') {
      lines.push('| RSI阈值 | 触发次数 | 14天均值 | 30天均值 | 分数 |', '| ---: | ---: | ---: | ---: | ---: |');
      item.rows.forEach((row) => {
        lines.push(
          `| ${row.rsiThreshold} | ${row.signals} | ${formatPercent(horizon(row, 14)?.averageReturn ?? 0)} | ${formatPercent(horizon(row, 30)?.averageReturn ?? 0)} | ${row.score.toFixed(4)} |`,
        );
      });
    } else {
      lines.push('| 回撤阈值 | 收回位置 | 触发次数 | 14天均值 | 30天均值 | 分数 |', '| ---: | ---: | ---: | ---: | ---: | ---: |');
      item.rows.forEach((row) => {
        lines.push(
          `| ${formatPercent(row.drawdownThreshold)} | ${formatPercent(row.recoveryThreshold)} | ${row.signals} | ${formatPercent(horizon(row, 14)?.averageReturn ?? 0)} | ${formatPercent(horizon(row, 30)?.averageReturn ?? 0)} | ${row.score.toFixed(4)} |`,
        );
      });
    }
    lines.push('');
  });

  lines.push(
    '',
    '## 策略回测',
    '',
    '口径：150 天内完成剩余 BTC，起点为 90 日回撤超过 12% 且趋势降温的窗口。',
    '',
    '| 策略 | 平均买入价 | 中位买入价 | 平均效率 | 下四分位效率 | 完成率 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  );

  report.strategy.rows.forEach((row) => {
    lines.push(
      `| ${row.name} | ${formatNumber(row.averageEntry)} | ${formatNumber(row.medianEntry)} | ${formatPercent(row.averageEfficiency)} | ${formatPercent(row.p25Efficiency)} | ${formatPercent(row.completionRate)} |`,
    );
  });

  lines.push('', '## 分阶段验证', '');
  report.regimes.forEach((group) => {
    lines.push(`### ${group.regime}`, '', '| 策略 | 样本 | 平均买入价 | 平均效率 | 下四分位效率 | 完成率 |', '| --- | ---: | ---: | ---: | ---: | ---: |');
    group.rows.forEach((row) => {
      lines.push(
        `| ${row.name} | ${row.samples} | ${formatNumber(row.averageEntry)} | ${formatPercent(row.averageEfficiency)} | ${formatPercent(row.p25Efficiency)} | ${formatPercent(row.completionRate)} |`,
      );
    });
    lines.push('');
  });

  lines.push(
    '## 执行含义',
    '',
    '- 默认动作：按周定投推进，不因为单一信号消失就停止计划。',
    '- 加速动作：4H 或 1D 出现排名靠前的相对抄底信号时，可以执行下一笔计划内买入。',
    '- 保守动作：只有 4H 有信号、1D/1W 不配合时，不提高单笔金额。',
    '- 极端动作：深熊阶段可以让阶梯单发挥作用，但仍保留预备仓，避免低位没钱补。',
    '',
  );

  return `${lines.join('\n')}\n`;
}

async function main() {
  await mkdir(reportsDir, { recursive: true });

  const candlesByInterval = {};
  for (const interval of Object.keys(backtestMarketConfig)) {
    candlesByInterval[interval] = await fetchBacktestCandles(interval);
  }

  const signalResults = [];
  for (const [interval, candles] of Object.entries(candlesByInterval)) {
    for (const candidate of signalCandidateDefinitions) {
      const result = evaluateSignalCandidate(candles, interval, candidate, backtestMarketConfig[interval].barsPerDay, signalHorizons);
      const resultWithStability = {
        ...result,
        score: scoreSignalResult(result),
        stability: evaluateSignalStability(candles, candidate, backtestMarketConfig[interval].barsPerDay, 30),
      };
      signalResults.push({
        ...resultWithStability,
        finding: classifyBacktestedSignal(resultWithStability),
      });
    }
  }

  const dailyCandles = candlesByInterval['1d'];
  const report = {
    generatedAt: new Date().toISOString(),
    targetBtc,
    windowDays,
    signals: {
      ranges: Object.fromEntries(Object.entries(candlesByInterval).map(([interval, candles]) => [interval, candleDateRange(candles)])),
      results: signalResults,
    },
    strategy: evaluateAccumulationStrategies(dailyCandles, targetBtc, { windowDays, startStepDays: 14 }),
    regimes: evaluateRegimes(dailyCandles),
    parameterSensitivity: evaluateParameterSensitivity(candlesByInterval),
    walkForward: evaluateWalkForward(candlesByInterval),
  };

  await writeFile(new URL('backtest-report.json', reportsDir), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(new URL('backtest-report.md', reportsDir), buildMarkdown(report));

  console.log(`Wrote ${new URL('backtest-report.json', reportsDir).pathname}`);
  console.log(`Wrote ${new URL('backtest-report.md', reportsDir).pathname}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
