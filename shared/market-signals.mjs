export const signalHorizons = [7, 14, 30];

export function average(values) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function percentile(values, percentileValue) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * percentileValue)));
  return sorted[index];
}

export function standardDeviation(values) {
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

export function rolling(candles, index, period) {
  return candles.slice(Math.max(0, index - period), index);
}

export function closePosition(candle) {
  return (candle.close - candle.low) / Math.max(1, candle.high - candle.low);
}

export function calculateRsiAt(candles, index, period = 14) {
  if (index < period) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let offset = index - period + 1; offset <= index; offset += 1) {
    const change = candles[offset].close - candles[offset - 1].close;
    if (change >= 0) {
      gains += change;
    } else {
      losses -= change;
    }
  }

  if (losses === 0) {
    return 100;
  }

  return 100 - 100 / (1 + gains / losses);
}

export function calculateRsiSeries(candles, period = 14) {
  return candles.map((_candle, index) => calculateRsiAt(candles, index, period));
}

export function trendIsCooling(candles, index) {
  const last90 = rolling(candles, index, 90);
  const last30 = rolling(candles, index, 30);
  if (last90.length < 90 || last30.length < 30) {
    return false;
  }

  return average(last30.map((candle) => candle.close)) < average(last90.map((candle) => candle.close)) * 1.04;
}

export function trendAllowsSignal(candles, index) {
  const last90 = rolling(candles, index, 90);
  const last30 = rolling(candles, index, 30);
  if (last90.length < 90 || last30.length < 30) {
    return true;
  }

  return average(last30.map((candle) => candle.close)) < average(last90.map((candle) => candle.close)) * 1.04;
}

export function calculateBottomSignalMetrics(candles, index) {
  if (index < 24 || index >= candles.length) {
    return null;
  }

  const latest = candles[index];
  const previous = candles[index - 1];
  const recentSeven = rolling(candles, index, 7);
  const recentTwenty = rolling(candles, index, 20);
  const localHigh = Math.max(...recentSeven.map((candle) => candle.high));
  const sevenDayDrawdown = latest.low / localHigh - 1;
  const closes = recentTwenty.map((candle) => candle.close);
  const lowerBand = average(closes) - 2 * standardDeviation(closes);
  const rsi14 = calculateRsiAt(candles, index) ?? 50;
  const previousRsi = calculateRsiAt(candles, index - 1) ?? rsi14;
  const rsiRising = rsi14 > previousRsi;
  const candleRecovered = closePosition(latest) >= 0.58;
  const bullishReversal = latest.close > previous.close || latest.close > latest.open;
  const shortDropSignal = sevenDayDrawdown <= -0.08 && rsiRising && bullishReversal && candleRecovered;
  const rsiSignal = previousRsi <= 32 && rsiRising && latest.close > previous.close;
  const bollingerSignal = latest.low <= lowerBand && latest.close > lowerBand && candleRecovered && rsiRising;

  return {
    latest,
    previous,
    sevenDayDrawdown,
    lowerBand,
    rsi14,
    previousRsi,
    rsiRising,
    deepPullback: sevenDayDrawdown <= -0.08 || latest.low <= lowerBand * 1.01,
    bullishReversal,
    closeRecovered: candleRecovered,
    shortDropSignal,
    rsiSignal,
    bollingerSignal,
  };
}

export function analyzeBottomSignalAt(candles, index) {
  const metrics = calculateBottomSignalMetrics(candles, index);
  if (!metrics) {
    return null;
  }

  const {
    latest,
    sevenDayDrawdown,
    rsi14,
    previousRsi,
    rsiRising,
    deepPullback,
    bullishReversal,
    closeRecovered,
    shortDropSignal,
    rsiSignal,
    bollingerSignal,
  } = metrics;
  const signalName = shortDropSignal ? '短跌过度反转' : rsiSignal ? 'RSI 超卖反转' : '布林下轨收回';

  if (trendAllowsSignal(candles, index) && (shortDropSignal || rsiSignal || bollingerSignal)) {
    return {
      time: latest.time,
      action: 'buy',
      title: `${signalName}：可执行下一笔`,
      summary: `近 7 根 K 线最大回撤 ${formatPercent(sevenDayDrawdown)}，RSI14 ${rsi14.toFixed(1)}，K 线从低位收回。适合执行计划内下一笔，不代表可以加速打满。`,
      signalName,
      sevenDayDrawdown,
      rsi14,
      rsiRising,
      deepPullback,
      bullishReversal,
      closeRecovered,
      latestClose: latest.close,
      latestLow: latest.low,
    };
  }

  if ((deepPullback && rsiRising) || (previousRsi <= 38 && bullishReversal)) {
    return {
      time: latest.time,
      action: 'watch',
      title: '接近止跌：等待确认',
      summary: '已经出现超跌或 RSI 回升迹象，但收盘反转还不够完整。更稳的做法是等下一根 K 线确认。',
      signalName: '观察信号',
      sevenDayDrawdown,
      rsi14,
      rsiRising,
      deepPullback,
      bullishReversal,
      closeRecovered,
      latestClose: latest.close,
      latestLow: latest.low,
    };
  }

  return {
    time: latest.time,
    action: 'wait',
    title: '未出现相对抄底信号',
    summary: '当前还没有同时出现明显短期超跌、RSI 回升和 K 线收回，继续等计划区间或下一根确认 K 线。',
    signalName: '等待',
    sevenDayDrawdown,
    rsi14,
    rsiRising,
    deepPullback,
    bullishReversal,
    closeRecovered,
    latestClose: latest.close,
    latestLow: latest.low,
  };
}

export function analyzeBottomSignal(candles) {
  return analyzeBottomSignalAt(candles, candles.length - 1);
}

export function collectBottomSignals(candles, minGapBars = 5) {
  const signals = [];
  let lastSignalIndex = -minGapBars - 1;

  for (let index = 45; index < candles.length; index += 1) {
    if (index - lastSignalIndex <= minGapBars) {
      continue;
    }

    const signal = analyzeBottomSignalAt(candles, index);
    if (signal?.action === 'buy') {
      signals.push(signal);
      lastSignalIndex = index;
    }
  }

  return signals;
}

export function backtestBottomSignals(candles, horizons = signalHorizons, barsPerDay = 1) {
  const signals = collectBottomSignals(candles);
  const horizonStats = horizons.map((days) => {
    const bars = Math.max(1, Math.round(days * barsPerDay));
    const returns = signals
      .map((signal) => {
        const signalIndex = candles.findIndex((candle) => candle.time === signal.time);
        const exit = candles[signalIndex + bars];
        const entry = candles[signalIndex];
        return entry && exit ? (exit.close - entry.close) / entry.close : null;
      })
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
    totalSignals: signals.length,
    latestSignalDate: signals.length ? new Date(signals[signals.length - 1].time).toLocaleDateString() : '-',
    horizons: horizonStats,
  };
}

export const signalCandidateDefinitions = [
  {
    name: '20日新低放量收回',
    minBars: 45,
    signal(candles, index) {
      const candle = candles[index];
      const previous = candles[index - 1];
      const last20 = rolling(candles, index, 20);
      const previousLow = Math.min(...last20.map((item) => item.low));
      const volumeRatio = candle.volume / Math.max(1, average(last20.map((item) => item.volume)));
      return (
        trendAllowsSignal(candles, index) &&
        candle.low < previousLow &&
        candle.close > previousLow &&
        volumeRatio >= 1.35 &&
        closePosition(candle) >= 0.55 &&
        candle.close >= previous.close * 0.985
      );
    },
  },
  {
    name: '布林下轨放量收回',
    minBars: 45,
    signal(candles, index) {
      const candle = candles[index];
      const last20 = rolling(candles, index, 20);
      const closes = last20.map((item) => item.close);
      const lowerBand = average(closes) - 2 * standardDeviation(closes);
      const volumeRatio = candle.volume / Math.max(1, average(last20.map((item) => item.volume)));
      return (
        trendAllowsSignal(candles, index) &&
        candle.low < lowerBand &&
        candle.close > lowerBand &&
        volumeRatio >= 1.25 &&
        closePosition(candle) >= 0.58
      );
    },
  },
  {
    name: 'RSI超卖反转',
    minBars: 45,
    withIndicators(candles) {
      return { rsi14: calculateRsiSeries(candles, 14) };
    },
    signal(candles, index, indicators) {
      const candle = candles[index];
      const previous = candles[index - 1];
      const rsi14 = indicators.rsi14[index];
      const previousRsi = indicators.rsi14[index - 1];
      const last20 = rolling(candles, index, 20);
      const volumeRatio = candle.volume / Math.max(1, average(last20.map((item) => item.volume)));
      return (
        trendAllowsSignal(candles, index) &&
        previousRsi !== null &&
        rsi14 !== null &&
        previousRsi <= 32 &&
        rsi14 > previousRsi &&
        candle.close > previous.close &&
        volumeRatio >= 1.05
      );
    },
  },
  {
    name: 'RSI+布林反转',
    minBars: 45,
    withIndicators(candles) {
      return { rsi14: calculateRsiSeries(candles, 14) };
    },
    signal(candles, index, indicators) {
      const candle = candles[index];
      const previous = candles[index - 1];
      const rsi14 = indicators.rsi14[index];
      const previousRsi = indicators.rsi14[index - 1];
      const last20 = rolling(candles, index, 20);
      const closes = last20.map((item) => item.close);
      const lowerBand = average(closes) - 2 * standardDeviation(closes);
      return (
        trendAllowsSignal(candles, index) &&
        previousRsi !== null &&
        rsi14 !== null &&
        previousRsi <= 38 &&
        rsi14 > previousRsi &&
        candle.low <= lowerBand * 1.01 &&
        candle.close > previous.close &&
        closePosition(candle) >= 0.55
      );
    },
  },
  {
    name: '短跌过度反转',
    minBars: 45,
    withIndicators(candles) {
      return { rsi14: calculateRsiSeries(candles, 14) };
    },
    signal(candles, index, indicators) {
      const candle = candles[index];
      const previous = candles[index - 1];
      const rsi14 = indicators.rsi14[index];
      const previousRsi = indicators.rsi14[index - 1];
      const last7 = rolling(candles, index, 7);
      const localHigh = Math.max(...last7.map((item) => item.high));
      const shortDrawdown = candle.low / localHigh - 1;
      return (
        trendAllowsSignal(candles, index) &&
        shortDrawdown <= -0.08 &&
        previousRsi !== null &&
        rsi14 !== null &&
        rsi14 > previousRsi &&
        candle.close > previous.close &&
        closePosition(candle) >= 0.58
      );
    },
  },
  {
    name: '三日止跌放量长下影',
    minBars: 45,
    signal(candles, index) {
      const candle = candles[index];
      const previous = candles[index - 1];
      const previousTwo = candles[index - 2];
      const last20 = rolling(candles, index, 20);
      const volumeRatio = candle.volume / Math.max(1, average(last20.map((item) => item.volume)));
      const lowerWick = Math.min(candle.open, candle.close) - candle.low;
      const body = Math.abs(candle.close - candle.open);
      return (
        trendAllowsSignal(candles, index) &&
        candle.low <= Math.min(previous.low, previousTwo.low) * 1.005 &&
        candle.close > previous.close &&
        closePosition(candle) >= 0.62 &&
        lowerWick > body * 1.2 &&
        volumeRatio >= 1.2
      );
    },
  },
  {
    name: '恐慌长下影',
    minBars: 45,
    signal(candles, index) {
      const candle = candles[index];
      const last20 = rolling(candles, index, 20);
      const last30 = rolling(candles, index, 30);
      const localHigh = Math.max(...last30.map((item) => item.high));
      const volumeRatio = candle.volume / Math.max(1, average(last20.map((item) => item.volume)));
      const lowerWick = Math.min(candle.open, candle.close) - candle.low;
      const range = Math.max(1, candle.high - candle.low);
      return (
        trendAllowsSignal(candles, index) &&
        candle.low / localHigh - 1 <= -0.12 &&
        volumeRatio >= 1.15 &&
        lowerWick / range >= 0.35 &&
        closePosition(candle) >= 0.6
      );
    },
  },
  {
    name: '应用综合信号',
    minBars: 45,
    signal(candles, index) {
      return analyzeBottomSignalAt(candles, index)?.action === 'buy';
    },
  },
];

export function cooldownSignalIndexes(candles, candidate, cooldownBars = 5) {
  const indicators = candidate.withIndicators?.(candles) ?? {};
  const signals = [];
  let lastSignalIndex = -cooldownBars - 1;

  for (let index = candidate.minBars; index < candles.length - 31; index += 1) {
    if (index - lastSignalIndex <= cooldownBars) {
      continue;
    }

    if (candidate.signal(candles, index, indicators)) {
      signals.push(index);
      lastSignalIndex = index;
    }
  }

  return signals;
}

export function evaluateSignalCandidate(candles, interval, candidate, barsPerDay, horizons = signalHorizons) {
  const signals = cooldownSignalIndexes(candles, candidate);
  const horizonStats = horizons.map((days) => {
    const bars = Math.max(1, Math.round(days * barsPerDay));
    const returns = signals
      .map((index) => (candles[index + bars] ? (candles[index + bars].close - candles[index].close) / candles[index].close : null))
      .filter((value) => value !== null);

    return {
      days,
      samples: returns.length,
      winRate: returns.length ? returns.filter((value) => value > 0).length / returns.length : 0,
      averageReturn: average(returns),
      medianReturn: percentile(returns, 0.5),
      p25Return: percentile(returns, 0.25),
    };
  });

  return {
    interval,
    name: candidate.name,
    signals: signals.length,
    latestSignal: signals.length ? new Date(candles[signals[signals.length - 1]].time).toISOString().slice(0, 10) : '-',
    horizonStats,
  };
}

export function scoreSignalResult(result) {
  const h14 = result.horizonStats.find((item) => item.days === 14);
  const h30 = result.horizonStats.find((item) => item.days === 30);
  if (!h14 || !h30 || h14.samples < 8) {
    return -Infinity;
  }

  return h14.averageReturn * 0.45 + h30.averageReturn * 0.35 + (h14.winRate - 0.5) * 0.12 + h14.p25Return * 0.08;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}
