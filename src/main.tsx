import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { evaluateAccumulationStrategies } from '../shared/accumulation-strategies.mjs';
import type { AccumulationBacktest } from '../shared/accumulation-strategies.mjs';
import { isPrimaryBottomSignal, isStrongFourHourDropSignal } from '../shared/decision-policy.mjs';
import {
  analyzeBottomSignal,
  backtestBottomSignals,
  collectBottomSignals,
} from '../shared/market-signals.mjs';
import type { BottomSignal, SignalBacktest } from '../shared/market-signals.mjs';
import './styles.css';

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type Trade = {
  id: string;
  date: string;
  side: 'buy' | 'sell';
  btcAmount: number;
  priceUsdt: number;
  feeUsdt: number;
  note: string;
};

type PlanSettings = {
  existingBtc: number;
  targetBtc: number;
  availableUsdt: number;
  targetDate: string;
};

type KlineInterval = '1h' | '4h' | '1d' | '1w' | '1M';
type KlineProvider = 'CryptoCompare' | 'Gate' | 'HTX' | 'OKX' | 'Binance';

type TradeDraft = Omit<Trade, 'id'>;

type StrategyBacktest = AccumulationBacktest;

type TimeframeSignalRow = {
  label: string;
  signal: BottomSignal | null;
  backtest: SignalBacktest;
};

type ChartLayers = {
  averages: boolean;
  bollinger: boolean;
  volume: boolean;
  signals: boolean;
  trades: boolean;
  planLines: boolean;
};

const storageKey = 'btc-dca-monitor-state-v1';

const defaultSettings: PlanSettings = {
  existingBtc: 0.16,
  targetBtc: 1,
  availableUsdt: 48600,
  targetDate: '2026-12-31',
};

const intervalOptions: Array<{ label: string; value: KlineInterval; limit: number }> = [
  { label: '1H', value: '1h', limit: 500 },
  { label: '4H', value: '4h', limit: 500 },
  { label: '1D', value: '1d', limit: 365 },
  { label: '1W', value: '1w', limit: 260 },
  { label: '1M', value: '1M', limit: 120 },
];

const barsPerDayByInterval: Record<KlineInterval, number> = {
  '1h': 24,
  '4h': 6,
  '1d': 1,
  '1w': 1 / 7,
  '1M': 1 / 30,
};

const defaultTradeDraft = (): TradeDraft => ({
  date: new Date().toISOString().slice(0, 10),
  side: 'buy',
  btcAmount: 0.01,
  priceUsdt: 58000,
  feeUsdt: 0,
  note: '',
});

function tradeDraftFromTrade(trade: Trade): TradeDraft {
  return {
    date: trade.date,
    side: trade.side,
    btcAmount: trade.btcAmount,
    priceUsdt: trade.priceUsdt,
    feeUsdt: trade.feeUsdt,
    note: trade.note,
  };
}

function normalizeTradeDraft(draft: TradeDraft): TradeDraft {
  return {
    date: draft.date || new Date().toISOString().slice(0, 10),
    side: draft.side,
    btcAmount: Math.max(0, draft.btcAmount),
    priceUsdt: Math.max(0, draft.priceUsdt),
    feeUsdt: Math.max(0, draft.feeUsdt),
    note: draft.note.trim(),
  };
}

const currency = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const btcFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
const klineCache = new Map<string, { candles: Candle[]; provider: KlineProvider }>();

const okxBarByInterval: Record<KlineInterval, string> = {
  '1h': '1H',
  '4h': '4H',
  '1d': '1D',
  '1w': '1W',
  '1M': '1M',
};

const htxPeriodByInterval: Record<KlineInterval, string> = {
  '1h': '60min',
  '4h': '4hour',
  '1d': '1day',
  '1w': '1week',
  '1M': '1mon',
};

const gateIntervalByInterval: Record<KlineInterval, string> = {
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
  '1w': '7d',
  '1M': '30d',
};

const cryptoCompareConfigByInterval: Record<KlineInterval, { endpoint: 'histohour' | 'histoday'; aggregate: number; limit: number }> = {
  '1h': { endpoint: 'histohour', aggregate: 1, limit: 500 },
  '4h': { endpoint: 'histohour', aggregate: 4, limit: 500 },
  '1d': { endpoint: 'histoday', aggregate: 1, limit: 365 },
  '1w': { endpoint: 'histoday', aggregate: 7, limit: 260 },
  '1M': { endpoint: 'histoday', aggregate: 30, limit: 120 },
};

const intervalMsByInterval: Record<KlineInterval, number> = {
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
  '1M': 30 * 24 * 60 * 60 * 1000,
};

function useRuntimeFixtureCandles() {
  return new URLSearchParams(window.location.search).get('runtimeFixture') === '1';
}

function createRuntimeFixtureCandles(interval: KlineInterval, limit: number): Candle[] {
  const stepMs = intervalMsByInterval[interval];
  const endTime = Date.UTC(2026, 5, 2, 0, 0, 0);
  const startTime = endTime - (limit - 1) * stepMs;

  return Array.from({ length: limit }, (_item, index) => {
    const cycle = index % 50;
    const cycleBase = 68_000 + Math.floor(index / 50) * 850;
    let open = cycleBase + cycle * 260;
    let close = open + (cycle % 5 < 3 ? 420 : -360);
    let high = Math.max(open, close) + 700;
    let low = Math.min(open, close) - 650;
    let volume = 900_000 + cycle * 8_000;

    if (cycle === 20) {
      open = cycleBase + 7_000;
      close = cycleBase - 1_600;
      high = open + 900;
      low = cycleBase - 4_600;
      volume = 2_200_000;
    } else if (cycle === 21) {
      open = cycleBase - 3_800;
      close = cycleBase - 900;
      high = close + 650;
      low = cycleBase - 4_900;
      volume = 2_500_000;
    } else if (cycle === 22) {
      open = cycleBase - 600;
      close = cycleBase + 1_600;
      high = close + 750;
      low = open - 700;
      volume = 1_800_000;
    }

    return {
      time: startTime + index * stepMs,
      open,
      high,
      low,
      close,
      volume,
    };
  });
}

function closedCandles(candles: Candle[], interval: KlineInterval) {
  const now = Date.now();
  const intervalMs = intervalMsByInterval[interval];
  return candles.filter((candle) => candle.time + intervalMs <= now);
}

async function fetchCryptoCompareCandles(interval: KlineInterval, signal: AbortSignal): Promise<Candle[]> {
  const config = cryptoCompareConfigByInterval[interval];
  const response = await fetch(
    `https://min-api.cryptocompare.com/data/v2/${config.endpoint}?fsym=BTC&tsym=USDT&limit=${config.limit}&aggregate=${config.aggregate}`,
    { signal },
  );

  if (!response.ok) {
    throw new Error(`CryptoCompare HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    Response: string;
    Message?: string;
    Data?: {
      Data?: Array<{
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volumefrom?: number;
        volumeto?: number;
      }>;
    };
  };

  if (payload.Response !== 'Success' || !payload.Data?.Data) {
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

async function fetchHtxCandles(interval: KlineInterval, limit: number, signal: AbortSignal): Promise<Candle[]> {
  const response = await fetch(
    `https://api.huobi.pro/market/history/kline?symbol=btcusdt&period=${htxPeriodByInterval[interval]}&size=${Math.min(limit, 300)}`,
    { signal },
  );

  if (!response.ok) {
    throw new Error(`HTX HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    status: string;
    errMsg?: string;
    data?: Array<{ id: number; open: number; high: number; low: number; close: number; amount?: number; vol?: number }>;
  };

  if (payload.status !== 'ok' || !payload.data) {
    throw new Error(`HTX ${payload.errMsg || payload.status}`);
  }

  return payload.data
    .map((row) => ({
      time: row.id * 1000,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: Math.max(0, row.vol ?? row.amount ?? 0),
    }))
    .sort((a, b) => a.time - b.time);
}

async function fetchGateCandles(interval: KlineInterval, limit: number, signal: AbortSignal): Promise<Candle[]> {
  const response = await fetch(
    `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=BTC_USDT&interval=${gateIntervalByInterval[interval]}&limit=${Math.min(limit, 300)}`,
    { signal },
  );

  if (!response.ok) {
    throw new Error(`Gate HTTP ${response.status}`);
  }

  const rows = (await response.json()) as string[][];
  return rows
    .map((row) => ({
      time: Number(row[0]) * 1000,
      open: Number(row[5]),
      high: Number(row[3]),
      low: Number(row[4]),
      close: Number(row[2]),
      volume: Math.max(0, Number(row[1])),
    }))
    .sort((a, b) => a.time - b.time);
}

async function fetchOkxCandles(interval: KlineInterval, limit: number, signal: AbortSignal): Promise<Candle[]> {
  const response = await fetch(
    `https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=${okxBarByInterval[interval]}&limit=${Math.min(limit, 300)}`,
    { signal },
  );

  if (!response.ok) {
    throw new Error(`OKX HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { code: string; msg?: string; data?: string[][] };
  if (payload.code !== '0' || !payload.data) {
    throw new Error(`OKX ${payload.msg || payload.code}`);
  }

  return payload.data
    .map((row) => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Math.max(0, Number(row[7] ?? row[6] ?? row[5] ?? 0)),
    }))
    .sort((a, b) => a.time - b.time);
}

async function fetchBinanceCandles(interval: KlineInterval, limit: number, signal: AbortSignal): Promise<Candle[]> {
  const response = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`,
    { signal },
  );

  if (!response.ok) {
    throw new Error(`Binance HTTP ${response.status}`);
  }

  const rows = (await response.json()) as Array<Array<number | string>>;
  return rows.map((row) => ({
    time: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Math.max(0, Number(row[7] ?? row[5] ?? 0)),
  }));
}

function readInitialState() {
  const stored = window.localStorage.getItem(storageKey);
  if (!stored) {
    return { settings: defaultSettings, trades: [] as Trade[] };
  }

  try {
    const parsed = JSON.parse(stored) as {
      settings?: Partial<PlanSettings> & { availableCny?: number; fxRate?: number; reserveCny?: number };
      trades?: Trade[];
    };
    const legacyAvailableUsdt =
      parsed.settings?.availableCny !== undefined
        ? Math.max(0, parsed.settings.availableCny - (parsed.settings.reserveCny ?? 0)) / (parsed.settings.fxRate ?? 7.2)
        : undefined;

    return {
      settings: {
        ...defaultSettings,
        ...parsed.settings,
        availableUsdt: parsed.settings?.availableUsdt ?? legacyAvailableUsdt ?? defaultSettings.availableUsdt,
        targetDate: parsed.settings?.targetDate ?? defaultSettings.targetDate,
      },
      trades: parsed.trades ?? [],
    };
  } catch {
    return { settings: defaultSettings, trades: [] as Trade[] };
  }
}

function signedTradeBtc(trade: Trade) {
  return trade.side === 'buy' ? trade.btcAmount : -trade.btcAmount;
}

function signedTradeCostUsdt(trade: Trade) {
  const gross = trade.btcAmount * trade.priceUsdt + trade.feeUsdt;
  return trade.side === 'buy' ? gross : -gross;
}

function useBtcCandles(interval: KlineInterval) {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [status, setStatus] = useState('加载 BTC/USDT K 线中...');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let isActive = true;
    const providerControllers: AbortController[] = [];
    const cachedCandles = klineCache.get(interval);
    const selectedInterval = intervalOptions.find((option) => option.value === interval) ?? intervalOptions[2];

    if (useRuntimeFixtureCandles()) {
      setCandles(createRuntimeFixtureCandles(interval, selectedInterval.limit));
      setStatus(`Fixture BTC/USDT ${selectedInterval.label}`);
      setError('');
      setIsLoading(false);
      return;
    }

    if (cachedCandles) {
      setCandles(cachedCandles.candles);
      setStatus(`${cachedCandles.provider} BTC/USDT ${selectedInterval.label}`);
      setError('');
      setIsLoading(false);
      return;
    }

    function loadProviderWithTimeout(candidate: { name: KlineProvider; load: (signal: AbortSignal) => Promise<Candle[]> }) {
      const controller = new AbortController();
      providerControllers.push(controller);
      const timeoutId = window.setTimeout(() => controller.abort(), 6000);

      return candidate.load(controller.signal).finally(() => window.clearTimeout(timeoutId));
    }

    async function load() {
      setIsLoading(true);
      setError('');
      setStatus(`加载 CryptoCompare BTC/USDT ${selectedInterval.label}...`);

      try {
        const providers: Array<{ name: KlineProvider; load: (signal: AbortSignal) => Promise<Candle[]> }> = [
          { name: 'CryptoCompare', load: (signal) => fetchCryptoCompareCandles(interval, signal) },
          { name: 'Gate', load: (signal) => fetchGateCandles(interval, selectedInterval.limit, signal) },
          { name: 'HTX', load: (signal) => fetchHtxCandles(interval, selectedInterval.limit, signal) },
          { name: 'OKX', load: (signal) => fetchOkxCandles(interval, selectedInterval.limit, signal) },
          { name: 'Binance', load: (signal) => fetchBinanceCandles(interval, selectedInterval.limit, signal) },
        ];
        const errors: string[] = [];
        let provider: KlineProvider | null = null;
        let nextCandles: Candle[] = [];

        for (const candidate of providers) {
          if (!isActive) {
            break;
          }

          try {
            setStatus(`加载 ${candidate.name} BTC/USDT ${selectedInterval.label}...`);
            nextCandles = await loadProviderWithTimeout(candidate);
            provider = candidate.name;
            break;
          } catch (candidateError) {
            const message = candidateError instanceof Error ? candidateError.message : '未知错误';
            errors.push(`${candidate.name}: ${message}`);
          }
        }

        if (!provider || nextCandles.length === 0) {
          throw new Error(errors.join('；') || '所有行情源均不可用');
        }

        if (!isActive) {
          return;
        }

        klineCache.set(interval, { candles: nextCandles, provider });
        setCandles(nextCandles);
        setStatus(`${provider} BTC/USDT ${selectedInterval.label}`);
      } catch (error) {
        if (isActive) {
          const message = error instanceof Error ? error.message : '未知错误';
          setError(`K 线加载失败：${message}`);
          setStatus(`BTC/USDT ${selectedInterval.label}`);
        }
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    }

    load();
    return () => {
      isActive = false;
      providerControllers.forEach((controller) => controller.abort());
    };
  }, [interval]);

  return { candles, error, isLoading, status };
}

function App() {
  const initialState = useMemo(readInitialState, []);
  const [settings, setSettings] = useState<PlanSettings>(initialState.settings);
  const [trades, setTrades] = useState<Trade[]>(initialState.trades);
  const [draft, setDraft] = useState<TradeDraft>(defaultTradeDraft);
  const [editingTradeId, setEditingTradeId] = useState<string | null>(null);
  const [interval, setInterval] = useState<KlineInterval>('1d');
  const [showChart, setShowChart] = useState(true);
  const [showResearch, setShowResearch] = useState(false);
  const [chartLayers, setChartLayers] = useState<ChartLayers>({
    averages: true,
    bollinger: false,
    volume: true,
    signals: true,
    trades: true,
    planLines: true,
  });
  const { candles, error, isLoading, status } = useBtcCandles(interval);
  const fourHourMarket = useBtcCandles('4h');
  const dailyMarket = useBtcCandles('1d');
  const weeklyMarket = useBtcCandles('1w');
  const closedSelectedCandles = useMemo(() => closedCandles(candles, interval), [candles, interval]);
  const closedFourHourCandles = useMemo(() => closedCandles(fourHourMarket.candles, '4h'), [fourHourMarket.candles]);
  const closedDailyCandles = useMemo(() => closedCandles(dailyMarket.candles, '1d'), [dailyMarket.candles]);
  const closedWeeklyCandles = useMemo(() => closedCandles(weeklyMarket.candles, '1w'), [weeklyMarket.candles]);
  const bottomSignal = useMemo(() => analyzeBottomSignal(closedSelectedCandles), [closedSelectedCandles]);
  const bottomSignals = useMemo(() => collectBottomSignals(closedSelectedCandles), [closedSelectedCandles]);
  const signalBacktest = useMemo(() => backtestBottomSignals(closedSelectedCandles, undefined, barsPerDayByInterval[interval]), [closedSelectedCandles, interval]);
  const timeframeSignals = useMemo(
    () => [
      {
        label: '4H',
        signal: analyzeBottomSignal(closedFourHourCandles),
        backtest: backtestBottomSignals(closedFourHourCandles, undefined, barsPerDayByInterval['4h']),
      },
      {
        label: '1D',
        signal: analyzeBottomSignal(closedDailyCandles),
        backtest: backtestBottomSignals(closedDailyCandles, undefined, barsPerDayByInterval['1d']),
      },
      {
        label: '1W',
        signal: analyzeBottomSignal(closedWeeklyCandles),
        backtest: backtestBottomSignals(closedWeeklyCandles, undefined, barsPerDayByInterval['1w']),
      },
    ],
    [closedDailyCandles, closedFourHourCandles, closedWeeklyCandles],
  );
  const strategyBacktest = useMemo(
    () => evaluateAccumulationStrategies(closedDailyCandles, Math.max(0, settings.targetBtc - settings.existingBtc)),
    [closedDailyCandles, settings.existingBtc, settings.targetBtc],
  );

  const latestPrice = candles.length > 0 ? candles[candles.length - 1].close : draft.priceUsdt;
  const isEditingTrade = editingTradeId !== null;

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify({ settings, trades }));
  }, [settings, trades]);

  const metrics = useMemo(() => {
    const buyTrades = trades.filter((trade) => trade.side === 'buy');
    const netTradeBtc = trades.reduce((sum, trade) => sum + signedTradeBtc(trade), 0);
    const totalBuyBtc = buyTrades.reduce((sum, trade) => sum + trade.btcAmount, 0);
    const netTradeCostUsdt = trades.reduce((sum, trade) => sum + signedTradeCostUsdt(trade), 0);
    const buyCostUsdt = buyTrades.reduce((sum, trade) => sum + trade.btcAmount * trade.priceUsdt + trade.feeUsdt, 0);
    const spentUsdt = Math.max(0, netTradeCostUsdt);
    const remainingBudgetUsdt = Math.max(0, settings.availableUsdt - spentUsdt);
    const currentBtc = settings.existingBtc + netTradeBtc;
    const remainingBtcToTarget = Math.max(0, settings.targetBtc - currentBtc);
    const currentBuyAverage = totalBuyBtc > 0 ? buyCostUsdt / totalBuyBtc : 0;
    const requiredAverageFromNow = remainingBtcToTarget > 0 ? remainingBudgetUsdt / remainingBtcToTarget : 0;
    const initialBtcGap = Math.max(0, settings.targetBtc - settings.existingBtc);
    const planTargetAverageUsdt = initialBtcGap > 0 ? settings.availableUsdt / initialBtcGap : 0;
    const averageGap = latestPrice - planTargetAverageUsdt;
    const priceVsRequired = requiredAverageFromNow > 0 ? latestPrice - requiredAverageFromNow : 0;

    const today = new Date();
    const targetDateObj = new Date(settings.targetDate || today.toISOString().slice(0, 10));
    const weeksRemaining = Math.max(1, (targetDateObj.getTime() - today.getTime()) / (1000 * 60 * 60 * 24 * 7));
    const weeklyBtc = remainingBtcToTarget / weeksRemaining;
    const weeklyUsdt = weeklyBtc * latestPrice;

    const totalRequiredUsdtAtCurrentPrice = remainingBtcToTarget * latestPrice;
    const fundingGapUsdt = Math.max(0, totalRequiredUsdtAtCurrentPrice - remainingBudgetUsdt);
    const affordableWeeklyUsdt = remainingBudgetUsdt / weeksRemaining;
    const affordableWeeklyBtc = latestPrice > 0 ? affordableWeeklyUsdt / latestPrice : 0;

    return {
      buyCostUsdt,
      currentBtc,
      currentBuyAverage,
      remainingBtcToTarget,
      remainingBudgetUsdt,
      requiredAverageFromNow,
      spentUsdt,
      planTargetAverageUsdt,
      totalBuyBtc,
      averageGap,
      priceVsRequired,
      weeklyBtc,
      weeklyUsdt,
      weeksRemaining,
      fundingGapUsdt,
      affordableWeeklyUsdt,
      affordableWeeklyBtc,
    };
  }, [latestPrice, settings, trades]);

  const advice = useMemo(() => {
    const messages: string[] = [];
    const targetSpentUsdt = settings.availableUsdt;
    const spentUsdt = metrics.buyCostUsdt;
    const boughtBtc = metrics.totalBuyBtc;
    const remainingRoomUsdt = Math.max(0, targetSpentUsdt - spentUsdt);
    const maxBuyAtLatest = latestPrice > 0 ? remainingRoomUsdt / latestPrice : 0;
    const targetPreservingBuy = Math.max(0, Math.min(maxBuyAtLatest, metrics.remainingBtcToTarget));

    if (metrics.remainingBtcToTarget <= 0) {
      messages.push('已经达到 1 BTC 目标。后续只建议在极端低估区间加码，不需要为了达标继续追买。');
    } else if (metrics.requiredAverageFromNow < metrics.planTargetAverageUsdt * 0.96) {
      messages.push('剩余预算要求后续均价明显低于自动目标，难度偏高。当前阶段应降低买入频率，等待相对抄底信号再执行下一笔。');
    } else if (latestPrice <= metrics.planTargetAverageUsdt) {
      messages.push(`现价低于自动目标均价 ${currency.format(metrics.planTargetAverageUsdt)} USDT，可以执行一笔小到中等仓位买入。若要守住初始资金约束，本轮最多建议买 ${btcFormat.format(targetPreservingBuy)} BTC。`);
    } else if (latestPrice <= metrics.requiredAverageFromNow) {
      messages.push('现价低于剩余预算所需均价，但高于你的理想目标均价。适合小额定投，不适合一次性打满。');
    } else {
      messages.push('现价高于达标所需均价。为了当前 USDT 仓位完成 1 BTC，当前应只做小额观察单，主力资金等待更低区间。');
    }

    if (boughtBtc > 0 && metrics.currentBuyAverage > metrics.planTargetAverageUsdt) {
      const catchUpPrice = metrics.planTargetAverageUsdt * 0.96;
      const neededAtCatchUp =
        (metrics.currentBuyAverage * boughtBtc - metrics.planTargetAverageUsdt * boughtBtc) /
        Math.max(1, metrics.planTargetAverageUsdt - catchUpPrice);
      messages.push(`当前后续买入均价高于自动目标。若后续能在自动目标下方约 4% 的位置买入，约需 ${btcFormat.format(Math.max(0, neededAtCatchUp))} BTC 才能把后续均价拉回 ${currency.format(metrics.planTargetAverageUsdt)} USDT 附近。`);
    }

    messages.push('建议节奏：默认周定投；主信号出现时执行下一笔；多周期共振时可以提高到计划内金额；极端预备仓只在深度相对回撤和强确认同时出现时动用。');
    return messages;
  }, [latestPrice, metrics, settings]);

  function updateSetting<K extends keyof PlanSettings>(key: K, value: PlanSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function submitTrade(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedDraft = normalizeTradeDraft(draft);
    if (normalizedDraft.btcAmount <= 0 || normalizedDraft.priceUsdt <= 0) {
      return;
    }

    if (editingTradeId) {
      setTrades((current) =>
        current.map((trade) =>
          trade.id === editingTradeId
            ? {
                ...normalizedDraft,
                id: trade.id,
              }
            : trade,
        ),
      );
      setEditingTradeId(null);
    } else {
      setTrades((current) => [
        {
          ...normalizedDraft,
          id: crypto.randomUUID(),
        },
        ...current,
      ]);
    }

    setDraft({ ...defaultTradeDraft(), priceUsdt: Math.round(latestPrice) });
  }

  function startEditingTrade(trade: Trade) {
    setEditingTradeId(trade.id);
    setDraft(tradeDraftFromTrade(trade));
  }

  function cancelEditingTrade() {
    setEditingTradeId(null);
    setDraft({ ...defaultTradeDraft(), priceUsdt: Math.round(latestPrice) });
  }

  function deleteTrade(id: string) {
    setTrades((current) => current.filter((trade) => trade.id !== id));
    if (editingTradeId === id) {
      cancelEditingTrade();
    }
  }

  function resetDemoData() {
    setTrades([]);
    cancelEditingTrade();
  }

  function toggleChartLayer(layer: keyof ChartLayers) {
    setChartLayers((current) => ({ ...current, [layer]: !current[layer] }));
  }

  return (
    <main className="app-shell">
      <section className="hero panel">
        <div>
          <p className="eyebrow">BTC/USDT Accumulation Terminal</p>
          <h1>BTC 熊市抄底交易监控台</h1>
          <p className="hero-copy">
            记录接下来每笔 BTC 交易，实时计算后续买入均价、剩余缺口、剩余所需均价，并把交易点标到 BTC/USDT K 线上。
          </p>
        </div>
        <div className="target-card">
          <span>自动目标均价</span>
          <strong>{currency.format(metrics.planTargetAverageUsdt)} USDT</strong>
          <small>可用 USDT / 初始 BTC 缺口自动计算</small>
        </div>
      </section>

      <section className="grid metrics-grid">
        <Metric label="当前总持仓" value={`${btcFormat.format(metrics.currentBtc)} BTC`} hint={`距目标还差 ${btcFormat.format(metrics.remainingBtcToTarget)} BTC`} />
        <Metric label="后续买入均价" value={metrics.currentBuyAverage ? `${currency.format(metrics.currentBuyAverage)} USDT` : '暂无'} hint={`自动目标 ${currency.format(metrics.planTargetAverageUsdt)} USDT`} />
        <Metric label="剩余可用仓位" value={`${currency.format(metrics.remainingBudgetUsdt)} USDT`} hint={`已支出 ${currency.format(metrics.spentUsdt)} USDT`} />
        <Metric label="剩余所需均价" value={metrics.requiredAverageFromNow ? `${currency.format(metrics.requiredAverageFromNow)} USDT` : '已达标'} hint="剩余资金 / 剩余 BTC 缺口" />
        <Metric label="每周建议定投" value={`${btcFormat.format(metrics.weeklyBtc)} BTC`} hint={
          metrics.fundingGapUsdt > 0 ? (
            <span style={{ color: '#ffb4b4' }}>
              缺口 {currency.format(metrics.fundingGapUsdt)} USDT<br/>
              按余量每周仅能投 {btcFormat.format(metrics.affordableWeeklyBtc)} BTC
            </span>
          ) : (
            `约合 ${currency.format(metrics.weeklyUsdt)} USDT (现价)`
          )
        } />
      </section>

      <section className="layout">
        <div className="panel chart-panel">
          <div className="section-title">
            <div>
              <h2>BTC/USDT K 线 <button className="link-button" style={{ marginLeft: '12px', fontSize: '12px' }} onClick={() => setShowChart(!showChart)}>{showChart ? '隐藏' : '显示'}</button></h2>
              <p>{status}</p>
            </div>
            <div className="chart-actions">
              <div className="layer-tabs">
                <button className={chartLayers.averages ? 'active' : ''} onClick={() => toggleChartLayer('averages')}>MA</button>
                <button className={chartLayers.bollinger ? 'active' : ''} onClick={() => toggleChartLayer('bollinger')}>BOLL</button>
                <button className={chartLayers.volume ? 'active' : ''} onClick={() => toggleChartLayer('volume')}>VOL</button>
                <button className={chartLayers.signals ? 'active' : ''} onClick={() => toggleChartLayer('signals')}>信号</button>
                <button className={chartLayers.trades ? 'active' : ''} onClick={() => toggleChartLayer('trades')}>交易</button>
                <button className={chartLayers.planLines ? 'active' : ''} onClick={() => toggleChartLayer('planLines')}>计划线</button>
              </div>
              <div className="interval-tabs">
                {intervalOptions.map((option) => (
                  <button
                    key={option.value}
                    className={option.value === interval ? 'active' : ''}
                    disabled={isLoading}
                    onClick={() => setInterval(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="price-pill">现价 {currency.format(latestPrice)} USDT</div>
            </div>
          </div>
          {showChart && (
            <CandlestickChart
              candles={candles}
              trades={trades}
              targetAverage={metrics.planTargetAverageUsdt}
              requiredAverage={metrics.requiredAverageFromNow}
              bottomSignals={bottomSignals}
              layers={chartLayers}
            />
          )}
          {error && showChart && <div className="chart-error">{error}</div>}
        </div>

        <aside className="panel settings-panel">
          <h2>计划参数</h2>
          <NumberField label="已有 BTC" value={settings.existingBtc} step="0.01" onChange={(value) => updateSetting('existingBtc', value)} />
          <NumberField label="目标 BTC" value={settings.targetBtc} step="0.01" onChange={(value) => updateSetting('targetBtc', value)} />
          <NumberField label="BTC 可用仓位 USDT" value={settings.availableUsdt} step="100" onChange={(value) => updateSetting('availableUsdt', value)} />
          <label className="number-field">
            目标日期
            <input type="date" value={settings.targetDate} onChange={(event) => updateSetting('targetDate', event.target.value)} />
          </label>
          <div className="computed-field">
            <span>自动目标均价</span>
            <strong>{currency.format(metrics.planTargetAverageUsdt)} USDT</strong>
            <small>由可用仓位和目标 BTC 自动推出，不需要手动填。</small>
          </div>
        </aside>
      </section>

      <section className="layout lower-layout">
        <div className="panel">
          <h2>{isEditingTrade ? '修改交易' : '录入交易'}</h2>
          <form className="trade-form" onSubmit={submitTrade}>
            <label>
              日期
              <input type="date" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} />
            </label>
            <label>
              方向
              <select value={draft.side} onChange={(event) => setDraft({ ...draft, side: event.target.value as Trade['side'] })}>
                <option value="buy">买入</option>
                <option value="sell">卖出</option>
              </select>
            </label>
            <label>
              BTC 数量
              <input type="number" min="0" step="0.000001" value={draft.btcAmount} onChange={(event) => setDraft({ ...draft, btcAmount: Number(event.target.value) })} />
            </label>
            <label>
              成交价 USDT
              <input type="number" min="0" step="1" value={draft.priceUsdt} onChange={(event) => setDraft({ ...draft, priceUsdt: Number(event.target.value) })} />
            </label>
            <label>
              手续费 USDT
              <input type="number" min="0" step="0.01" value={draft.feeUsdt} onChange={(event) => setDraft({ ...draft, feeUsdt: Number(event.target.value) })} />
            </label>
            <label className="wide-field">
              备注
              <input value={draft.note} placeholder="例如：主信号买入 / DCA / 清扫补仓" onChange={(event) => setDraft({ ...draft, note: event.target.value })} />
            </label>
            <div className="trade-form-actions">
              <button type="submit">{isEditingTrade ? '保存修改' : '保存交易'}</button>
              {isEditingTrade && <button type="button" className="secondary-button" onClick={cancelEditingTrade}>取消</button>}
            </div>
          </form>
        </div>

        <div className="panel advice-panel">
          <h2>本轮抄底建议</h2>
          <ExecutionDecisionCard rows={timeframeSignals} />
          <ActionSummary
            signal={bottomSignal}
            rows={timeframeSignals}
            latestPrice={latestPrice}
            requiredAverage={metrics.requiredAverageFromNow}
            planTargetAverage={metrics.planTargetAverageUsdt}
            advice={advice}
          />
          <button className="research-toggle" onClick={() => setShowResearch((current) => !current)}>
            {showResearch ? '收起研究依据' : '展开研究依据'}
          </button>
          {showResearch && (
            <div className="research-stack">
              <BottomSignalCard signal={bottomSignal} />
              <MultiTimeframeSignalCard rows={timeframeSignals} />
              <SignalBacktestCard backtest={signalBacktest} />
              <StrategyBacktestCard backtest={strategyBacktest} />
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="section-title">
          <div>
            <h2>交易记录</h2>
            <p>数据保存在当前浏览器本地，不会上传。</p>
          </div>
          <button className="ghost-button" onClick={resetDemoData}>清空记录</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>方向</th>
                <th>数量</th>
                <th>成交价</th>
                <th>金额</th>
                <th>备注</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {trades.length === 0 ? (
                <tr>
                  <td colSpan={7} className="empty-cell">还没有交易记录。先录入下一笔买入，图上会自动出现标记。</td>
                </tr>
              ) : (
                trades.map((trade) => (
                  <tr key={trade.id} className={trade.id === editingTradeId ? 'editing-row' : undefined}>
                    <td>{trade.date}</td>
                    <td><span className={trade.side === 'buy' ? 'buy-tag' : 'sell-tag'}>{trade.side === 'buy' ? '买入' : '卖出'}</span></td>
                    <td>{btcFormat.format(trade.btcAmount)} BTC</td>
                    <td>{currency.format(trade.priceUsdt)} USDT</td>
                    <td>{currency.format(trade.btcAmount * trade.priceUsdt + trade.feeUsdt)} USDT</td>
                    <td>{trade.note || '-'}</td>
                    <td>
                      <div className="table-actions">
                        <button className="link-button" onClick={() => startEditingTrade(trade)}>编辑</button>
                        <button className="link-button" onClick={() => deleteTrade(trade.id)}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function NumberField(props: { label: string; value: number; step: string; onChange: (value: number) => void }) {
  return (
    <label className="number-field">
      {props.label}
      <input type="number" step={props.step} value={props.value} onChange={(event) => props.onChange(Number(event.target.value))} />
    </label>
  );
}

function ExecutionDecisionCard(props: { rows: TimeframeSignalRow[] }) {
  const buyRows = props.rows.filter((row) => row.signal?.action === 'buy');
  const watchRows = props.rows.filter((row) => row.signal?.action === 'watch');
  const primaryBuyRows = buyRows.filter(isPrimaryBottomSignal);
  const dailySignal = props.rows.find((row) => row.label === '1D')?.signal;
  const fourHourSignal = props.rows.find((row) => row.label === '4H')?.signal;
  const weeklySignal = props.rows.find((row) => row.label === '1W')?.signal;
  const hasDailyBuy = dailySignal?.action === 'buy';
  const hasFourHourBuy = fourHourSignal?.action === 'buy';
  const hasWeeklyBuy = weeklySignal?.action === 'buy';
  const hasDailyWatch = dailySignal?.action === 'watch';
  const hasFourHourWatch = fourHourSignal?.action === 'watch';
  const buyLabels = buyRows.map((row) => row.label).join(' + ');
  const watchLabels = watchRows.map((row) => row.label).join(' + ');
  const hasPrimaryBuy = primaryBuyRows.length > 0;
  const hasStrongFourHourDrop = props.rows.some(isStrongFourHourDropSignal);

  let level = 'wait';
  let title = '默认：继续周定投，不加速';
  let summary = '当前没有形成足够的多周期共振。按计划推进，避免因为单根 K 线提前打掉预备仓。';
  let action = '只执行既定周定投；不提高单笔金额。';

  if (hasPrimaryBuy && ((hasDailyBuy && hasFourHourBuy) || (hasDailyBuy && hasWeeklyBuy))) {
    level = 'buy';
    title = '加速：可以执行下一笔计划内买入';
    summary = `当前 ${buyLabels} 出现相对抄底信号，并包含长样本更稳的主信号。${hasStrongFourHourDrop ? '4H 回撤已进入强确认区。' : ''}`;
    action = '可以买下一笔计划内金额；仍不要一次性打满剩余仓位。';
  } else if (hasPrimaryBuy || (hasFourHourBuy && hasWeeklyBuy)) {
    level = 'buy';
    title = '可买：执行小到中等一笔';
    summary = `当前 ${buyLabels} 出现信号，但共振或稳定性还不完整。${hasStrongFourHourDrop ? '4H 回撤较深，优先级高于普通 4H 信号。' : ''}`;
    action = '可以买一笔小到中等仓位，用作计划内推进。';
  } else if (hasFourHourBuy || hasDailyWatch || hasFourHourWatch) {
    level = 'watch';
    title = '观察：等下一根确认';
    summary = buyLabels ? `当前只有 ${buyLabels} 给出买入信号，但不是长样本主信号。` : `当前 ${watchLabels || '部分周期'} 接近止跌，但还没有买入确认。`;
    action = '不加速；如果下一根 4H/1D 继续收回，再执行下一笔。';
  }

  return (
    <div className={`decision-card decision-card-${level}`}>
      <div>
        <span>{level === 'buy' ? '执行' : level === 'watch' ? '观察' : '等待'}</span>
        <strong>{title}</strong>
      </div>
      <p>{summary}</p>
      <small>{action}</small>
    </div>
  );
}

function ActionSummary(props: {
  signal: BottomSignal | null;
  rows: TimeframeSignalRow[];
  latestPrice: number;
  requiredAverage: number;
  planTargetAverage: number;
  advice: string[];
}) {
  const daily = props.rows.find((row) => row.label === '1D')?.signal;
  const fourHour = props.rows.find((row) => row.label === '4H')?.signal;
  const weekly = props.rows.find((row) => row.label === '1W')?.signal;
  const dailyText = daily ? `${actionText(daily.action)} / RSI ${daily.rsi14.toFixed(1)}` : '数据不足';
  const fourHourText = fourHour ? `${actionText(fourHour.action)} / RSI ${fourHour.rsi14.toFixed(1)}` : '数据不足';
  const weeklyText = weekly ? `${actionText(weekly.action)} / RSI ${weekly.rsi14.toFixed(1)}` : '数据不足';
  const priceGap = props.requiredAverage > 0 ? props.latestPrice - props.requiredAverage : 0;

  return (
    <div className="action-summary">
      <div className="action-focus">
        <span>当前执行</span>
        <strong>{props.advice[0] ?? '继续等待相对抄底信号。'}</strong>
      </div>
      <div className="action-facts">
        <div>
          <span>1D 主信号</span>
          <strong>{dailyText}</strong>
        </div>
        <div>
          <span>4H 确认</span>
          <strong>{fourHourText}</strong>
        </div>
        <div>
          <span>1W 背景</span>
          <strong>{weeklyText}</strong>
        </div>
      </div>
      <div className="action-reasons">
        <span>{props.signal ? `当前周期：${props.signal.signalName}` : '当前周期：数据不足'}</span>
        <span>现价较剩余所需均价 {priceGap >= 0 ? '高' : '低'} {currency.format(Math.abs(priceGap))} USDT</span>
        <span>自动目标均价 {currency.format(props.planTargetAverage)} USDT</span>
      </div>
      <p>{props.advice[props.advice.length - 1]}</p>
    </div>
  );
}

function actionText(action: BottomSignal['action']) {
  if (action === 'buy') {
    return '可买';
  }
  if (action === 'watch') {
    return '观察';
  }
  return '等待';
}

function BottomSignalCard(props: { signal: BottomSignal | null }) {
  if (!props.signal) {
    return (
      <div className="signal-card signal-card-wait">
        <strong>相对抄底信号计算中</strong>
        <p>K 线数据不足，暂时只执行既定周定投，不因为现价位置加速。</p>
      </div>
    );
  }

  const actionLabel = props.signal.action === 'buy' ? '可买' : props.signal.action === 'watch' ? '观察' : '等待';

  return (
    <div className={`signal-card signal-card-${props.signal.action}`}>
      <div className="signal-card-header">
        <span>{actionLabel}</span>
        <strong>{props.signal.title}</strong>
      </div>
      <p>{props.signal.summary}</p>
      <div className="signal-checks">
        <SignalCheck label={`7根K回撤 ${percentFormat(props.signal.sevenDayDrawdown)}`} active={props.signal.deepPullback} />
        <SignalCheck label={`RSI ${props.signal.rsi14.toFixed(1)} 回升`} active={props.signal.rsiRising} />
        <SignalCheck label="日线收回" active={props.signal.closeRecovered || props.signal.bullishReversal} />
      </div>
      <small>
        最新 K 线：低点 {currency.format(props.signal.latestLow)}，收盘 {currency.format(props.signal.latestClose)} USDT
      </small>
    </div>
  );
}

function SignalCheck(props: { label: string; active: boolean }) {
  return <span className={props.active ? 'signal-check active' : 'signal-check'}>{props.label}</span>;
}

function MultiTimeframeSignalCard(props: {
  rows: Array<{
    label: string;
    signal: BottomSignal | null;
    backtest: SignalBacktest;
  }>;
}) {
  return (
    <div className="backtest-card">
      <div className="backtest-header">
        <strong>多周期信号</strong>
        <span>4H / 1D / 1W</span>
      </div>
      <div className="timeframe-signal-list">
        {props.rows.map((row) => {
          const action = row.signal?.action ?? 'wait';
          const actionLabel = action === 'buy' ? '可买' : action === 'watch' ? '观察' : '等待';
          const latest = row.signal ? `${row.signal.signalName} / RSI ${row.signal.rsi14.toFixed(1)}` : '数据不足';

          return (
            <div key={row.label}>
              <strong>{row.label}</strong>
              <span className={`timeframe-action timeframe-action-${action}`}>{actionLabel}</span>
              <small>{latest}</small>
              <small>
                样本 {row.backtest.totalSignals} / 30天均值 {percentFormat(row.backtest.horizons.find((item) => item.days === 30)?.averageReturn ?? 0)}
              </small>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function percentFormat(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function SignalBacktestCard(props: { backtest: SignalBacktest | null }) {
  if (!props.backtest) {
    return (
      <div className="backtest-card">
        <strong>信号回测</strong>
        <p>K 线数据不足，暂时无法回测。</p>
      </div>
    );
  }

  return (
    <div className="backtest-card">
      <div className="backtest-header">
        <strong>信号回测</strong>
        <span>
          {props.backtest.totalSignals} 次触发，最近 {props.backtest.latestSignalDate}
        </span>
      </div>
      {props.backtest.totalSignals < 5 && (
        <p className="backtest-warning">样本偏少，只能辅助判断，不单独作为买入依据。</p>
      )}
      <div className="backtest-grid">
        {props.backtest.horizons.map((horizon) => (
          <div key={horizon.days}>
            <span>{horizon.days} 天</span>
            <strong>{percentFormat(horizon.averageReturn)}</strong>
            <small>
              胜率 {percentFormat(horizon.winRate)} / 样本 {horizon.samples}
            </small>
          </div>
        ))}
      </div>
    </div>
  );
}

function StrategyBacktestCard(props: { backtest: StrategyBacktest | null }) {
  if (!props.backtest) {
    return (
      <div className="backtest-card">
        <strong>策略回测</strong>
        <p>日线数据不足，暂时无法比较定投策略。</p>
      </div>
    );
  }

  const best = props.backtest.rows.reduce((winner, row) => (row.averageEfficiency > winner.averageEfficiency ? row : winner), props.backtest.rows[0]);
  const weekly = props.backtest.rows.find((row) => row.key === 'weeklyDca');
  const bestAdvantage = weekly ? best.averageEfficiency - weekly.averageEfficiency : 0;

  return (
    <div className="backtest-card">
      <div className="backtest-header">
        <strong>策略回测</strong>
        <span>{props.backtest.samples} 个熊市窗口</span>
      </div>
      <p className="backtest-warning">
        这块不是当前买入信号，只是在比较“未来 150 天怎么把剩余 BTC 买完”。
      </p>
      <p className="backtest-note">
        当前样本里「{best.name}」平均效率最高，较周定投 {bestAdvantage >= 0 ? '高' : '低'} {percentFormat(Math.abs(bestAdvantage))}。样本只有 {props.backtest.samples} 个窗口，只能作为执行框架参考。
      </p>
      <div className="backtest-explain">
        <span>效率越高，说明买入均价越靠近窗口低点。</span>
        <span>下四分位越高，说明差行情里也不太差。</span>
        <span>完成率表示 150 天内是否买够目标 BTC。</span>
      </div>
      <div className="strategy-backtest-list">
        {props.backtest.rows.map((row) => (
          <div key={row.name}>
            <strong>{row.name}</strong>
            <span>效率 {percentFormat(row.averageEfficiency)} / 均价 {currency.format(row.averageEntry)}</span>
            <small>
              下四分位 {percentFormat(row.p25Efficiency)} / 完成率 {percentFormat(row.completionRate)}
            </small>
          </div>
        ))}
      </div>
    </div>
  );
}

function Metric(props: { label: string; value: React.ReactNode; hint: React.ReactNode }) {
  return (
    <div className="metric-card panel">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <small>{props.hint}</small>
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function movingAverageSeries(candles: Candle[], period: number) {
  return candles.map((_candle, index) => {
    if (index + 1 < period) {
      return null;
    }

    const window = candles.slice(index + 1 - period, index + 1);
    return window.reduce((sum, candle) => sum + candle.close, 0) / period;
  });
}

function bollingerSeries(candles: Candle[], period: number) {
  return candles.map((_candle, index) => {
    if (index + 1 < period) {
      return null;
    }

    const window = candles.slice(index + 1 - period, index + 1);
    const mean = window.reduce((sum, candle) => sum + candle.close, 0) / period;
    const variance = window.reduce((sum, candle) => sum + (candle.close - mean) ** 2, 0) / period;
    const deviation = Math.sqrt(variance);
    return {
      upper: mean + deviation * 2,
      lower: mean - deviation * 2,
    };
  });
}

function linePath(values: Array<number | null>, visibleStart: number, visibleEnd: number, xScale: (index: number) => number, yScale: (price: number) => number) {
  const commands: string[] = [];
  let isDrawing = false;

  for (let index = visibleStart; index <= visibleEnd; index += 1) {
    const value = values[index];
    if (value === null || value === undefined || !Number.isFinite(value)) {
      isDrawing = false;
      continue;
    }

    commands.push(`${isDrawing ? 'L' : 'M'} ${xScale(index).toFixed(2)} ${yScale(value).toFixed(2)}`);
    isDrawing = true;
  }

  return commands.join(' ');
}

function percentileNumber(values: number[], percentile: number) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * percentile)));
  return sorted[index];
}

function CandlestickChart(props: {
  candles: Candle[];
  trades: Trade[];
  targetAverage: number;
  requiredAverage: number;
  bottomSignals: BottomSignal[];
  layers: ChartLayers;
}) {
  const chartRef = useRef<SVGSVGElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef({
    active: false,
    mode: 'pan' as 'pan' | 'price-scale',
    startX: 0,
    startY: 0,
    startRightIndex: 0,
    startPriceOffset: 0,
    startPriceRangeScale: 1,
    startPriceRange: 1,
  });
  const [hoveredCandle, setHoveredCandle] = useState<Candle | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [visibleCount, setVisibleCount] = useState(120);
  const [rightIndex, setRightIndex] = useState(0);
  const [priceOffset, setPriceOffset] = useState(0);
  const [priceRangeScale, setPriceRangeScale] = useState(1);
  const width = 1180;
  const height = props.layers.volume ? 520 : 420;
  const volumePaneHeight = props.layers.volume ? 92 : 0;
  const paneGap = props.layers.volume ? 18 : 0;
  const padding = { top: 28, right: 96, bottom: 38 + volumePaneHeight + paneGap, left: 20 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const minVisibleCount = Math.min(48, props.candles.length || 48);

  useEffect(() => {
    if (props.candles.length > 0) {
      setVisibleCount(Math.min(120, props.candles.length));
      setRightIndex(props.candles.length - 1);
    }
  }, [props.candles.length]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || props.candles.length === 0) {
      return;
    }

    const handleNativeWheel = (event: WheelEvent) => {
      event.preventDefault();
      applyWheelNavigation(event.deltaX, event.deltaY, event.clientX);
    };

    viewport.addEventListener('wheel', handleNativeWheel, { passive: false });

    return () => {
      viewport.removeEventListener('wheel', handleNativeWheel);
    };
  });

  useEffect(() => {
    const stopGlobalPan = () => {
      if (!dragStateRef.current.active) {
        return;
      }

      dragStateRef.current.active = false;
      setIsDragging(false);
    };

    window.addEventListener('pointerup', stopGlobalPan);
    window.addEventListener('pointercancel', stopGlobalPan);
    window.addEventListener('blur', stopGlobalPan);

    return () => {
      window.removeEventListener('pointerup', stopGlobalPan);
      window.removeEventListener('pointercancel', stopGlobalPan);
      window.removeEventListener('blur', stopGlobalPan);
    };
  }, []);

  if (props.candles.length === 0) {
    return <div className="chart-placeholder">正在加载 K 线...</div>;
  }

  const maxVisibleCount = props.candles.length;
  const effectiveVisibleCount = clamp(visibleCount, minVisibleCount, maxVisibleCount);
  const effectiveRightIndex = clamp(rightIndex, Math.min(effectiveVisibleCount - 1, maxVisibleCount - 1), maxVisibleCount - 1);
  const visibleStart = Math.max(0, effectiveRightIndex - effectiveVisibleCount + 1);
  const visibleEnd = effectiveRightIndex;
  const visibleCandles = props.candles.slice(visibleStart, visibleEnd + 1);
  const ma20 = movingAverageSeries(props.candles, 20);
  const ma60 = movingAverageSeries(props.candles, 60);
  const bollinger = bollingerSeries(props.candles, 20);

  const tradeMarkers = props.trades
    .map((trade) => {
      const tradeTime = new Date(`${trade.date}T00:00:00`).getTime();
      let nearestIndex = 0;
      let nearestDistance = Number.POSITIVE_INFINITY;

      props.candles.forEach((candle, index) => {
        const distance = Math.abs(candle.time - tradeTime);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = index;
        }
      });

      return { trade, index: nearestIndex };
    })
    .filter((marker) => marker.index >= visibleStart && marker.index <= visibleEnd);

  const signalMarkers = props.bottomSignals
    .map((signal) => {
      let nearestIndex = 0;
      let nearestDistance = Number.POSITIVE_INFINITY;

      props.candles.forEach((candle, index) => {
        const distance = Math.abs(candle.time - signal.time);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = index;
        }
      });

      return { signal, index: nearestIndex };
    })
    .filter((marker, markerIndex, markers) => {
      if (marker.index < visibleStart || marker.index > visibleEnd) {
        return false;
      }

      return markers.findIndex((item) => item.index === marker.index) === markerIndex;
    });

  const visibleTradePrices = props.layers.trades ? tradeMarkers.map((marker) => marker.trade.priceUsdt) : [];
  const visibleSignalPrices = props.layers.signals ? signalMarkers.map((marker) => marker.signal.latestLow) : [];
  const visibleIndicatorPrices = visibleCandles.flatMap((_candle, offset) => {
    const index = visibleStart + offset;
    const values: number[] = [];
    if (props.layers.averages) {
      if (ma20[index]) values.push(ma20[index]!);
      if (ma60[index]) values.push(ma60[index]!);
    }
    if (props.layers.bollinger && bollinger[index]) {
      values.push(bollinger[index]!.upper, bollinger[index]!.lower);
    }
    return values;
  });
  const referencePrices = [
    ...(props.layers.planLines ? [props.targetAverage, props.requiredAverage || props.targetAverage] : []),
    ...visibleTradePrices,
    ...visibleSignalPrices,
    ...visibleIndicatorPrices,
  ];
  const baseMinPrice = Math.min(...visibleCandles.map((candle) => candle.low), ...referencePrices) * 0.985;
  const baseMaxPrice = Math.max(...visibleCandles.map((candle) => candle.high), ...referencePrices) * 1.015;
  const basePriceCenter = (baseMinPrice + baseMaxPrice) / 2;
  const scaledHalfRange = ((baseMaxPrice - baseMinPrice) * priceRangeScale) / 2;
  const minPrice = basePriceCenter + priceOffset - scaledHalfRange;
  const maxPrice = basePriceCenter + priceOffset + scaledHalfRange;
  const candleStep = plotWidth / Math.max(1, effectiveVisibleCount - 1);
  const bodyWidth = clamp(candleStep * 0.72, 3, 32);

  const xScale = (index: number) => {
    const ratio = (index - visibleStart) / Math.max(1, effectiveVisibleCount - 1);
    return padding.left + ratio * plotWidth;
  };

  const yScale = (price: number) => {
    const ratio = (price - minPrice) / Math.max(1, maxPrice - minPrice);
    return height - padding.bottom - ratio * plotHeight;
  };

  const gridPrices = [maxPrice, minPrice + (maxPrice - minPrice) * 0.75, (maxPrice + minPrice) / 2, minPrice + (maxPrice - minPrice) * 0.25, minPrice];
  const dateTicks = [visibleStart, Math.round((visibleStart + visibleEnd) / 2), visibleEnd]
    .filter((index, offset, indexes) => index >= 0 && index < props.candles.length && indexes.indexOf(index) === offset);
  const hoveredIndex = hoveredCandle ? props.candles.findIndex((candle) => candle.time === hoveredCandle.time) : -1;
  const hoveredX = hoveredIndex >= 0 ? xScale(hoveredIndex) : 0;
  const hoveredY = hoveredCandle ? yScale(hoveredCandle.close) : 0;
  const selectedCandle = hoveredCandle ?? visibleCandles[visibleCandles.length - 1];
  const maxVisibleVolume = Math.max(1, percentileNumber(visibleCandles.map((candle) => candle.volume), 0.92));
  const pricePaneBottom = height - padding.bottom;
  const volumeTop = pricePaneBottom + paneGap;
  const volumeBottom = height - 38;
  const volumeHeight = Math.max(0, volumeBottom - volumeTop);

  function handlePointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (dragStateRef.current.active) {
      return;
    }

    const svg = chartRef.current;
    if (!svg) {
      return;
    }

    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * width;
    const ratio = clamp((x - padding.left) / plotWidth, 0, 1);
    const nearestIndex = clamp(Math.round(visibleStart + ratio * (effectiveVisibleCount - 1)), visibleStart, visibleEnd);
    setHoveredCandle(props.candles[nearestIndex]);
  }

  function startPan(event: React.PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * width;
    const mode = x >= width - padding.right ? 'price-scale' : 'pan';

    dragStateRef.current = {
      active: true,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      startRightIndex: effectiveRightIndex,
      startPriceOffset: priceOffset,
      startPriceRangeScale: priceRangeScale,
      startPriceRange: maxPrice - minPrice,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
  }

  function movePan(event: React.PointerEvent<SVGSVGElement>) {
    if (!dragStateRef.current.active) {
      return;
    }

    const deltaX = event.clientX - dragStateRef.current.startX;
    const deltaY = event.clientY - dragStateRef.current.startY;

    if (dragStateRef.current.mode === 'price-scale') {
      const nextScale = clamp(dragStateRef.current.startPriceRangeScale * Math.exp(deltaY / 180), 0.35, 5);
      setPriceRangeScale(nextScale);
      return;
    }

    const candleDelta = Math.round(deltaX / Math.max(1, candleStep));
    const nextRightIndex = clamp(dragStateRef.current.startRightIndex - candleDelta, Math.min(effectiveVisibleCount - 1, maxVisibleCount - 1), maxVisibleCount - 1);
    const nextPriceOffset = dragStateRef.current.startPriceOffset + (deltaY / plotHeight) * dragStateRef.current.startPriceRange;

    setRightIndex(nextRightIndex);
    setPriceOffset(nextPriceOffset);
  }

  function stopPan(event: React.PointerEvent<SVGSVGElement>) {
    dragStateRef.current.active = false;
    setIsDragging(false);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function applyWheelNavigation(deltaX: number, deltaY: number, clientX: number) {
    const svg = chartRef.current;
    const rect = svg?.getBoundingClientRect();

    if (svg && rect) {
      const pointerX = ((clientX - rect.left) / rect.width) * width;
      if (pointerX >= width - padding.right) {
        const nextScale = clamp(priceRangeScale * (deltaY > 0 ? 1.14 : 0.88), 0.35, 5);
        setPriceRangeScale(nextScale);
        return;
      }
    }

    if (Math.abs(deltaX) > Math.abs(deltaY)) {
      const panDelta = Math.round(deltaX / Math.max(1, candleStep));
      setRightIndex((current) => clamp(current + panDelta, Math.min(effectiveVisibleCount - 1, maxVisibleCount - 1), maxVisibleCount - 1));
      return;
    }

    if (!svg) {
      return;
    }

    const pointerX = ((clientX - rect!.left) / rect!.width) * width;
    const anchorRatio = clamp((pointerX - padding.left) / plotWidth, 0, 1);
    const anchorIndex = visibleStart + anchorRatio * (effectiveVisibleCount - 1);
    const zoomFactor = deltaY > 0 ? 1.16 : 0.86;
    const nextVisibleCount = clamp(Math.round(effectiveVisibleCount * zoomFactor), minVisibleCount, maxVisibleCount);
    const nextRightIndex = Math.round(anchorIndex + (nextVisibleCount - 1) * (1 - anchorRatio));

    setVisibleCount(nextVisibleCount);
    setRightIndex(clamp(nextRightIndex, Math.min(nextVisibleCount - 1, maxVisibleCount - 1), maxVisibleCount - 1));
  }

  function zoom(multiplier: number) {
    const nextVisibleCount = clamp(Math.round(effectiveVisibleCount * multiplier), minVisibleCount, maxVisibleCount);
    const midpointIndex = visibleStart + (effectiveVisibleCount - 1) / 2;
    const nextRightIndex = Math.round(midpointIndex + (nextVisibleCount - 1) / 2);

    setVisibleCount(nextVisibleCount);
    setRightIndex(clamp(nextRightIndex, Math.min(nextVisibleCount - 1, maxVisibleCount - 1), maxVisibleCount - 1));
  }

  function jumpToLatest() {
    setRightIndex(maxVisibleCount - 1);
    setPriceOffset(0);
    setPriceRangeScale(1);
  }

  return (
    <div className="chart-shell">
      <div className={`chart-viewport ${isDragging ? 'dragging' : ''}`} ref={viewportRef}>
        <svg
          ref={chartRef}
          className="kline-chart"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="BTC/USDT candlestick chart with trade markers"
          onPointerDown={startPan}
          onPointerMove={handlePointerMove}
          onPointerMoveCapture={movePan}
          onPointerUp={stopPan}
          onPointerCancel={stopPan}
          onPointerLeave={() => setHoveredCandle(null)}
        >
        <rect width={width} height={height} rx="6" />
        {gridPrices.map((price) => (
          <g key={price}>
            <line className="grid-line" x1={padding.left} x2={width - padding.right} y1={yScale(price)} y2={yScale(price)} />
            <text className="axis-label" x={width - padding.right + 10} y={yScale(price) + 4}>{currency.format(price)}</text>
          </g>
        ))}
        {props.layers.planLines && props.requiredAverage > 0 && (
          <>
            <line className="required-line" x1={padding.left} x2={width - padding.right} y1={yScale(props.requiredAverage)} y2={yScale(props.requiredAverage)} />
          </>
        )}
        {props.layers.planLines && <line className="target-line" x1={padding.left} x2={width - padding.right} y1={yScale(props.targetAverage)} y2={yScale(props.targetAverage)} />}
        {dateTicks.map((index) => (
          <text key={index} className="time-label" x={xScale(index)} y={height - 12} textAnchor={index === visibleEnd ? 'end' : index === visibleStart ? 'start' : 'middle'}>
            {new Date(props.candles[index].time).toLocaleDateString()}
          </text>
        ))}
        {props.layers.bollinger && (
          <>
            <path className="bollinger-line" d={linePath(bollinger.map((item) => item?.upper ?? null), visibleStart, visibleEnd, xScale, yScale)} />
            <path className="bollinger-line bollinger-lower" d={linePath(bollinger.map((item) => item?.lower ?? null), visibleStart, visibleEnd, xScale, yScale)} />
          </>
        )}
        {props.layers.averages && (
          <>
            <path className="ma20-line" d={linePath(ma20, visibleStart, visibleEnd, xScale, yScale)} />
            <path className="ma60-line" d={linePath(ma60, visibleStart, visibleEnd, xScale, yScale)} />
          </>
        )}
        {visibleCandles.map((candle, offset) => {
          const candleIndex = visibleStart + offset;
          const x = xScale(candleIndex);
          const isUp = candle.close >= candle.open;
          const yOpen = yScale(candle.open);
          const yClose = yScale(candle.close);
          const yHigh = yScale(candle.high);
          const yLow = yScale(candle.low);
          const bodyY = Math.min(yOpen, yClose);
          const bodyHeight = Math.max(1, Math.abs(yClose - yOpen));

          return (
            <g key={candle.time} className={isUp ? 'candle-up' : 'candle-down'}>
              <line x1={x} x2={x} y1={yHigh} y2={yLow} />
              <rect x={x - bodyWidth / 2} y={bodyY} width={bodyWidth} height={bodyHeight} rx="1" />
            </g>
          );
        })}
        {props.layers.trades && tradeMarkers.map(({ trade, index }) => {
          const x = xScale(index);
          const y = yScale(trade.priceUsdt);
          const isBuy = trade.side === 'buy';

          return (
            <g key={trade.id} className={isBuy ? 'trade-buy' : 'trade-sell'}>
              <circle cx={x} cy={y} r="6" />
              <text x={x + 9} y={y - 9}>{isBuy ? 'B' : 'S'} {currency.format(trade.priceUsdt)}</text>
            </g>
          );
        })}
        {props.layers.signals && signalMarkers.map(({ signal, index }) => {
          const x = xScale(index);
          const y = yScale(signal.latestLow) + 18;

          return (
            <g key={signal.time} className="bottom-signal-marker">
              <path d={`M ${x} ${y - 7} L ${x + 7} ${y} L ${x} ${y + 7} L ${x - 7} ${y} Z`} />
              <text x={x + 10} y={y + 4}>抄底</text>
            </g>
          );
        })}
        {props.layers.volume && (
          <g className="volume-pane">
            <rect className="volume-pane-bg" x={padding.left} y={volumeTop} width={plotWidth} height={volumeHeight} rx="4" />
            <line className="volume-pane-separator" x1={padding.left} x2={width - padding.right} y1={volumeTop} y2={volumeTop} />
            <text className="volume-pane-label" x={padding.left + 8} y={volumeTop + 15}>VOL</text>
            {visibleCandles.map((candle, offset) => {
              const candleIndex = visibleStart + offset;
              const x = xScale(candleIndex);
              const volumeRatio = Math.sqrt(Math.min(1, candle.volume / maxVisibleVolume));
              const barHeight = Math.max(3, volumeRatio * (volumeHeight - 14));
              const isUp = candle.close >= candle.open;

              return (
                <rect
                  key={`volume-${candle.time}`}
                  className={isUp ? 'volume-pane-bar volume-pane-bar-up' : 'volume-pane-bar volume-pane-bar-down'}
                  x={x - bodyWidth / 2}
                  y={volumeBottom - barHeight}
                  width={bodyWidth}
                  height={barHeight}
                  rx="1"
                />
              );
            })}
          </g>
        )}
        {hoveredCandle && (
          <g className="hover-layer">
            <line x1={hoveredX} x2={hoveredX} y1={padding.top} y2={props.layers.volume ? volumeBottom : height - padding.bottom} />
            <line x1={padding.left} x2={width - padding.right} y1={hoveredY} y2={hoveredY} />
            <circle cx={hoveredX} cy={hoveredY} r="4" />
          </g>
        )}
        </svg>
      </div>
      <div className="chart-ohlc-bar">
        <strong>{new Date(selectedCandle.time).toLocaleString()}</strong>
        <span>O {currency.format(selectedCandle.open)}</span>
        <span>H {currency.format(selectedCandle.high)}</span>
        <span>L {currency.format(selectedCandle.low)}</span>
        <span>C {currency.format(selectedCandle.close)}</span>
      </div>
      <div className="chart-footer">
        <div className="chart-reference-panel">
          {props.layers.planLines && <div><i className="required-swatch" />剩余所需均价 <strong>{props.requiredAverage > 0 ? currency.format(props.requiredAverage) : '达标'} USDT</strong></div>}
          {props.layers.planLines && <div><i className="target-swatch" />自动目标均价 <strong>{currency.format(props.targetAverage)} USDT</strong></div>}
          {props.layers.averages && <div><i className="ma20-swatch" />MA20 / MA60</div>}
          {props.layers.bollinger && <div><i className="bollinger-swatch" />布林带</div>}
        </div>
        <div className="chart-floating-controls">
          <button onClick={() => zoom(0.86)}>+</button>
          <button onClick={() => zoom(1.16)}>-</button>
          <button onClick={jumpToLatest}>最新</button>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
