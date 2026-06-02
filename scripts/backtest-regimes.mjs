import { candleDateRange, fetchBacktestCandles } from './market-data.mjs';
import { accumulationStrategies } from '../shared/accumulation-strategies.mjs';
import { average, percentile, rolling } from '../shared/market-signals.mjs';

const targetBtc = 0.83223;
const windowDays = 150;

function classifyRegime(candles, startIndex) {
  if (startIndex < 180 || startIndex + windowDays >= candles.length) return null;
  const last180 = rolling(candles, startIndex, 180);
  const last90 = rolling(candles, startIndex, 90);
  const last30 = rolling(candles, startIndex, 30);
  const high180 = Math.max(...last180.map((candle) => candle.high));
  const drawdown = candles[startIndex].close / high180 - 1;
  const ma30 = average(last30.map((candle) => candle.close));
  const ma90 = average(last90.map((candle) => candle.close));
  const slopeCooling = ma30 < ma90 * 1.02;

  if (drawdown <= -0.35 && slopeCooling) return 'deepBear';
  if (drawdown <= -0.20 && slopeCooling) return 'bearPullback';
  if (drawdown <= -0.12) return 'ordinaryPullback';
  return null;
}

function evaluate(candles) {
  const groups = new Map();
  for (let startIndex = 200; startIndex + windowDays < candles.length; startIndex += 14) {
    const regime = classifyRegime(candles, startIndex);
    if (!regime) continue;
    const windowCandles = candles.slice(startIndex, startIndex + windowDays);
    if (!groups.has(regime)) groups.set(regime, new Map());
    const regimeGroup = groups.get(regime);
    for (const strategy of accumulationStrategies) {
      if (!regimeGroup.has(strategy.name)) regimeGroup.set(strategy.name, []);
      regimeGroup.get(strategy.name).push(strategy.run(candles, startIndex, windowCandles, targetBtc));
    }
  }
  return groups;
}

function printGroup(regime, strategyMap) {
  console.log(`\n# ${regime}`);
  for (const [name, results] of strategyMap.entries()) {
    const efficiencies = results.map((result) => result.efficiency);
    const entries = results.map((result) => result.averagePrice);
    const completion = results.filter((result) => result.completed).length / Math.max(1, results.length);
    console.log(
      `${name.padEnd(14)} samples=${String(results.length).padStart(3)} avgEntry=${average(entries).toFixed(0)} efficiency=${(average(efficiencies) * 100).toFixed(1)}% p25=${(percentile(efficiencies, 0.25) * 100).toFixed(1)}% complete=${(completion * 100).toFixed(1)}%`,
    );
  }
}

async function main() {
  const candles = await fetchBacktestCandles('1d');
  const range = candleDateRange(candles);
  console.log(`# regime backtest candles=${candles.length} ${range.start}..${range.end}`);
  console.log('# regimes: deepBear <= -35%, bearPullback <= -20%, ordinaryPullback <= -12% vs 180d high');
  const groups = evaluate(candles);
  for (const [regime, strategyMap] of groups.entries()) {
    printGroup(regime, strategyMap);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
