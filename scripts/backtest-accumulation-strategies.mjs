import { candleDateRange, fetchBacktestCandles } from './market-data.mjs';
import { evaluateAccumulationStrategies } from '../shared/accumulation-strategies.mjs';

const targetBtc = 0.83223;
const windowDays = 150;

function printStrategy(result) {
  console.log(
    `${result.name.padEnd(18)} avgEntry=${result.averageEntry.toFixed(0)} medianEntry=${result.medianEntry.toFixed(0)} efficiency=${(result.averageEfficiency * 100).toFixed(1)}% p25=${(result.p25Efficiency * 100).toFixed(1)}% complete=${(result.completionRate * 100).toFixed(1)}%`,
  );
}

async function main() {
  const candles = await fetchBacktestCandles('1d');
  const range = candleDateRange(candles);
  console.log(`# accumulation strategy backtest candles=${candles.length} ${range.start}..${range.end}`);
  console.log('# windows: 150 days, sampled every 14 days, only when 90d drawdown <= -12% and trend filter active');
  const result = evaluateAccumulationStrategies(candles, targetBtc, { windowDays, startStepDays: 14 });
  console.log(`# samples=${result?.samples ?? 0}`);
  result?.rows.forEach(printStrategy);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
