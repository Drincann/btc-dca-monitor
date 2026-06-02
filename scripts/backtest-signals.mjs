import { backtestMarketConfig, candleDateRange, fetchBacktestCandles } from './market-data.mjs';
import { evaluateSignalCandidate, scoreSignalResult, signalCandidateDefinitions, signalHorizons } from '../shared/market-signals.mjs';

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function printResult(result) {
  const statsText = result.horizonStats
    .map((stat) => `${stat.days}d avg ${formatPercent(stat.averageReturn)} win ${formatPercent(stat.winRate)} p25 ${formatPercent(stat.p25Return)} n=${stat.samples}`)
    .join(' | ');
  console.log(`${result.interval.padEnd(2)} ${result.name.padEnd(14)} signals=${String(result.signals).padStart(3)} latest=${result.latestSignal} score=${scoreSignalResult(result).toFixed(4)} | ${statsText}`);
}

async function main() {
  const intervals = Object.keys(backtestMarketConfig);
  const allResults = [];

  for (const interval of intervals) {
    const candles = await fetchBacktestCandles(interval);
    const range = candleDateRange(candles);
    console.log(`\n# ${interval} candles=${candles.length} ${range.start}..${range.end}`);
    for (const candidate of signalCandidateDefinitions) {
      const result = evaluateSignalCandidate(candles, interval, candidate, backtestMarketConfig[interval].barsPerDay, signalHorizons);
      allResults.push(result);
      printResult(result);
    }
  }

  console.log('\n# ranked');
  allResults
    .sort((a, b) => scoreSignalResult(b) - scoreSignalResult(a))
    .slice(0, 8)
    .forEach(printResult);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
