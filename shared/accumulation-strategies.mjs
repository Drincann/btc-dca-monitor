import { analyzeBottomSignalAt, average, percentile, trendIsCooling } from './market-signals.mjs';

export const defaultWindowDays = 150;

function buy(trades, dayIndex, btcAmount, price) {
  if (btcAmount > 0) {
    trades.push({ dayIndex, btcAmount, price });
  }
}

export function summarizeAccumulationTrades(windowCandles, trades, targetBtc) {
  const totalBtc = trades.reduce((sum, trade) => sum + trade.btcAmount, 0);
  const totalCost = trades.reduce((sum, trade) => sum + trade.btcAmount * trade.price, 0);
  const averagePrice = totalBtc > 0 ? totalCost / totalBtc : 0;
  const windowLow = Math.min(...windowCandles.map((candle) => candle.low));
  const windowHigh = Math.max(...windowCandles.map((candle) => candle.high));
  const efficiency = (windowHigh - averagePrice) / Math.max(1, windowHigh - windowLow);

  return {
    totalBtc,
    averagePrice,
    totalCost,
    efficiency,
    completed: totalBtc >= targetBtc * 0.999,
  };
}

export function bearAccumulationWindow(candles, startIndex, windowDays = defaultWindowDays) {
  if (startIndex < 90 || startIndex + windowDays >= candles.length) {
    return false;
  }

  const last90High = Math.max(...candles.slice(startIndex - 90, startIndex).map((candle) => candle.high));
  const drawdown = candles[startIndex].close / last90High - 1;
  return drawdown <= -0.12 && trendIsCooling(candles, startIndex);
}

export function weeklyDcaStrategy(_candles, _startIndex, windowCandles, targetBtc) {
  const trades = [];
  const perBuy = targetBtc / 20;

  for (let day = 0; day < windowCandles.length && trades.length < 20; day += 7) {
    buy(trades, day, perBuy, windowCandles[day].close);
  }

  const bought = trades.reduce((sum, trade) => sum + trade.btcAmount, 0);
  buy(trades, windowCandles.length - 1, targetBtc - bought, windowCandles[windowCandles.length - 1].close);
  return summarizeAccumulationTrades(windowCandles, trades, targetBtc);
}

export function signalReserveStrategy(candles, startIndex, windowCandles, targetBtc) {
  const trades = [];
  const dcaPerBuy = (targetBtc * 0.3) / 20;
  let reserveBtc = targetBtc * 0.7;
  let lastSignalDay = -6;

  for (let day = 0; day < windowCandles.length; day += 1) {
    if (day % 7 === 0) {
      buy(trades, day, dcaPerBuy, windowCandles[day].close);
    }

    if (reserveBtc > 0 && day - lastSignalDay > 5 && analyzeBottomSignalAt(candles, startIndex + day)?.action === 'buy') {
      const btcAmount = Math.min(reserveBtc, targetBtc * 0.1);
      buy(trades, day, btcAmount, windowCandles[day].close);
      reserveBtc -= btcAmount;
      lastSignalDay = day;
    }
  }

  const bought = trades.reduce((sum, trade) => sum + trade.btcAmount, 0);
  buy(trades, windowCandles.length - 1, targetBtc - bought, windowCandles[windowCandles.length - 1].close);
  return summarizeAccumulationTrades(windowCandles, trades, targetBtc);
}

export function relativeLadderStrategy(_candles, _startIndex, windowCandles, targetBtc) {
  const trades = [];
  const startPrice = windowCandles[0].close;
  const dcaPerBuy = (targetBtc * 0.3) / 20;
  const ladders = [
    { drawdown: -0.04, btcAmount: targetBtc * 0.18, filled: false },
    { drawdown: -0.08, btcAmount: targetBtc * 0.18, filled: false },
    { drawdown: -0.12, btcAmount: targetBtc * 0.17, filled: false },
    { drawdown: -0.16, btcAmount: targetBtc * 0.14, filled: false },
    { drawdown: -0.20, btcAmount: targetBtc * 0.1, filled: false },
  ];

  for (let day = 0; day < windowCandles.length; day += 1) {
    if (day % 7 === 0) {
      buy(trades, day, dcaPerBuy, windowCandles[day].close);
    }

    for (const ladder of ladders) {
      const triggerPrice = startPrice * (1 + ladder.drawdown);
      if (!ladder.filled && windowCandles[day].low <= triggerPrice) {
        buy(trades, day, ladder.btcAmount, triggerPrice);
        ladder.filled = true;
      }
    }
  }

  const bought = trades.reduce((sum, trade) => sum + trade.btcAmount, 0);
  buy(trades, windowCandles.length - 1, targetBtc - bought, windowCandles[windowCandles.length - 1].close);
  return summarizeAccumulationTrades(windowCandles, trades, targetBtc);
}

export function blendedLadderReserveStrategy(candles, startIndex, windowCandles, targetBtc) {
  const trades = [];
  const startPrice = windowCandles[0].close;
  const dcaPerBuy = (targetBtc * 0.3) / 20;
  let reserveBtc = targetBtc * 0.2;
  let lastSignalDay = -6;
  const ladders = [
    { drawdown: -0.04, btcAmount: targetBtc * 0.12, filled: false },
    { drawdown: -0.08, btcAmount: targetBtc * 0.12, filled: false },
    { drawdown: -0.12, btcAmount: targetBtc * 0.11, filled: false },
    { drawdown: -0.16, btcAmount: targetBtc * 0.09, filled: false },
    { drawdown: -0.20, btcAmount: targetBtc * 0.06, filled: false },
  ];

  for (let day = 0; day < windowCandles.length; day += 1) {
    if (day % 7 === 0) {
      buy(trades, day, dcaPerBuy, windowCandles[day].close);
    }

    for (const ladder of ladders) {
      const triggerPrice = startPrice * (1 + ladder.drawdown);
      if (!ladder.filled && windowCandles[day].low <= triggerPrice) {
        buy(trades, day, ladder.btcAmount, triggerPrice);
        ladder.filled = true;
      }
    }

    if (reserveBtc > 0 && day - lastSignalDay > 5 && analyzeBottomSignalAt(candles, startIndex + day)?.action === 'buy') {
      const btcAmount = Math.min(reserveBtc, targetBtc * 0.05);
      buy(trades, day, btcAmount, windowCandles[day].close);
      reserveBtc -= btcAmount;
      lastSignalDay = day;
    }
  }

  const bought = trades.reduce((sum, trade) => sum + trade.btcAmount, 0);
  buy(trades, windowCandles.length - 1, targetBtc - bought, windowCandles[windowCandles.length - 1].close);
  return summarizeAccumulationTrades(windowCandles, trades, targetBtc);
}

export const accumulationStrategies = [
  { name: '周定投', key: 'weeklyDca', run: weeklyDcaStrategy },
  { name: '30定投+信号', key: 'signalReserve', run: signalReserveStrategy },
  { name: '30定投+阶梯', key: 'relativeLadder', run: relativeLadderStrategy },
  { name: '30定投+阶梯+预备', key: 'blendedLadderReserve', run: blendedLadderReserveStrategy },
];

export function evaluateAccumulationStrategies(candles, targetBtc, options = {}) {
  const windowDays = options.windowDays ?? defaultWindowDays;
  const startStepDays = options.startStepDays ?? 14;

  if (candles.length < 260 || targetBtc <= 0) {
    return null;
  }

  const samplesByStrategy = accumulationStrategies.map((strategy) => ({
    strategy,
    results: [],
  }));

  for (let startIndex = 100; startIndex + windowDays < candles.length; startIndex += startStepDays) {
    if (!bearAccumulationWindow(candles, startIndex, windowDays)) {
      continue;
    }

    const windowCandles = candles.slice(startIndex, startIndex + windowDays);
    samplesByStrategy.forEach((item) => item.results.push(item.strategy.run(candles, startIndex, windowCandles, targetBtc)));
  }

  return {
    samples: samplesByStrategy[0]?.results.length ?? 0,
    rows: samplesByStrategy.map((item) => ({
      name: item.strategy.name,
      key: item.strategy.key,
      averageEntry: average(item.results.map((result) => result.averagePrice)),
      medianEntry: percentile(item.results.map((result) => result.averagePrice), 0.5),
      averageEfficiency: average(item.results.map((result) => result.efficiency)),
      p25Efficiency: percentile(item.results.map((result) => result.efficiency), 0.25),
      completionRate: item.results.length > 0 ? item.results.filter((result) => result.completed).length / item.results.length : 0,
    })),
  };
}
