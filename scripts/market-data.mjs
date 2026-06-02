export const backtestMarketConfig = {
  '4h': { endpoint: 'histohour', aggregate: 4, limit: 2000, barsPerDay: 6, binanceInterval: '4h' },
  '1d': { endpoint: 'histoday', aggregate: 1, limit: 2000, barsPerDay: 1, binanceInterval: '1d' },
  '1w': { endpoint: 'histoday', aggregate: 7, limit: 1000, barsPerDay: 1 / 7, binanceInterval: '1w' },
};

export async function fetchCryptoCompareCandles(interval) {
  const config = backtestMarketConfig[interval];
  if (!config) {
    throw new Error(`Unsupported interval ${interval}`);
  }

  const url = `https://min-api.cryptocompare.com/data/v2/${config.endpoint}?fsym=BTC&tsym=USDT&limit=${config.limit}&aggregate=${config.aggregate}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CryptoCompare HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload.Response !== 'Success') {
    throw new Error(`CryptoCompare ${payload.Message || payload.Response}`);
  }

  return payload.Data.Data.map((row) => ({
    time: row.time * 1000,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: Math.max(0, row.volumeto ?? row.volumefrom ?? 0),
  })).sort((a, b) => a.time - b.time);
}

export async function fetchBinanceCandles(interval) {
  const config = backtestMarketConfig[interval];
  if (!config) {
    throw new Error(`Unsupported interval ${interval}`);
  }

  const candles = [];
  let startTime = Date.parse('2020-12-01T00:00:00Z');
  const endTime = Date.now();

  while (startTime < endTime) {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${config.binanceInterval}&limit=1000&startTime=${startTime}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Binance HTTP ${response.status}`);
    }

    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      break;
    }

    candles.push(
      ...rows.map((row) => ({
        time: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Math.max(0, Number(row[7] ?? row[5] ?? 0)),
      })),
    );

    const nextStartTime = Number(rows[rows.length - 1][0]) + 1;
    if (nextStartTime <= startTime) {
      break;
    }
    startTime = nextStartTime;
  }

  return candles.sort((a, b) => a.time - b.time);
}

export async function fetchBacktestCandles(interval) {
  try {
    return await fetchBinanceCandles(interval);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Binance failed for ${interval}: ${message}; falling back to CryptoCompare`);
    return fetchCryptoCompareCandles(interval);
  }
}

export function candleDateRange(candles) {
  if (candles.length === 0) {
    return { start: '-', end: '-' };
  }

  return {
    start: new Date(candles[0].time).toISOString().slice(0, 10),
    end: new Date(candles[candles.length - 1].time).toISOString().slice(0, 10),
  };
}
