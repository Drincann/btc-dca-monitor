import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
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
};

type KlineInterval = '1h' | '4h' | '1d' | '1w' | '1M';
type KlineProvider = 'HTX' | 'Gate' | 'OKX' | 'Binance';

type TradeDraft = Omit<Trade, 'id'>;

const storageKey = 'btc-dca-monitor-state-v1';

const defaultSettings: PlanSettings = {
  existingBtc: 0.16,
  targetBtc: 1,
  availableUsdt: 48600,
};

const intervalOptions: Array<{ label: string; value: KlineInterval; limit: number }> = [
  { label: '1H', value: '1h', limit: 500 },
  { label: '4H', value: '4h', limit: 500 },
  { label: '1D', value: '1d', limit: 365 },
  { label: '1W', value: '1w', limit: 260 },
  { label: '1M', value: '1M', limit: 120 },
];

const defaultTradeDraft = (): TradeDraft => ({
  date: new Date().toISOString().slice(0, 10),
  side: 'buy',
  btcAmount: 0.01,
  priceUsdt: 58000,
  feeUsdt: 0,
  note: '',
});

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
    data?: Array<{ id: number; open: number; high: number; low: number; close: number }>;
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
    const cachedCandles = klineCache.get(interval);
    const selectedInterval = intervalOptions.find((option) => option.value === interval) ?? intervalOptions[2];

    if (cachedCandles) {
      setCandles(cachedCandles.candles);
      setStatus(`${cachedCandles.provider} BTC/USDT ${selectedInterval.label}`);
      setError('');
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    let abortedByTimeout = false;
    const timeoutId = window.setTimeout(() => {
      abortedByTimeout = true;
      controller.abort();
    }, 10000);

    async function load() {
      setIsLoading(true);
      setError('');
      setStatus(`加载 HTX BTC/USDT ${selectedInterval.label}...`);

      try {
        const providers: Array<{ name: KlineProvider; load: () => Promise<Candle[]> }> = [
          { name: 'HTX', load: () => fetchHtxCandles(interval, selectedInterval.limit, controller.signal) },
          { name: 'Gate', load: () => fetchGateCandles(interval, selectedInterval.limit, controller.signal) },
          { name: 'OKX', load: () => fetchOkxCandles(interval, selectedInterval.limit, controller.signal) },
          { name: 'Binance', load: () => fetchBinanceCandles(interval, selectedInterval.limit, controller.signal) },
        ];
        const errors: string[] = [];
        let provider: KlineProvider | null = null;
        let nextCandles: Candle[] = [];

        for (const candidate of providers) {
          if (controller.signal.aborted) {
            break;
          }

          try {
            setStatus(`加载 ${candidate.name} BTC/USDT ${selectedInterval.label}...`);
            nextCandles = await candidate.load();
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

        klineCache.set(interval, { candles: nextCandles, provider });
        setCandles(nextCandles);
        setStatus(`${provider} BTC/USDT ${selectedInterval.label}`);
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : '未知错误';
          setError(`K 线加载失败：${message}`);
          setStatus(`BTC/USDT ${selectedInterval.label}`);
        } else if (abortedByTimeout) {
          setError('K 线请求超时，请稍后重试。');
          setStatus(`BTC/USDT ${selectedInterval.label}`);
        }
      } finally {
        window.clearTimeout(timeoutId);
        setIsLoading(false);
      }
    }

    load();
    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [interval]);

  return { candles, error, isLoading, status };
}

function App() {
  const initialState = useMemo(readInitialState, []);
  const [settings, setSettings] = useState<PlanSettings>(initialState.settings);
  const [trades, setTrades] = useState<Trade[]>(initialState.trades);
  const [draft, setDraft] = useState<TradeDraft>(defaultTradeDraft);
  const [interval, setInterval] = useState<KlineInterval>('1d');
  const { candles, error, isLoading, status } = useBtcCandles(interval);

  const latestPrice = candles.length > 0 ? candles[candles.length - 1].close : draft.priceUsdt;

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
    } else if (metrics.requiredAverageFromNow < 56000) {
      messages.push('剩余预算要求后续均价低于 56K，难度很高。当前阶段应降低买入频率，重点等 59K、56K、52K 三个区间。');
    } else if (latestPrice <= metrics.planTargetAverageUsdt) {
      messages.push(`现价低于自动目标均价 ${currency.format(metrics.planTargetAverageUsdt)} USDT，可以执行一笔小到中等仓位买入。若要守住初始资金约束，本轮最多建议买 ${btcFormat.format(targetPreservingBuy)} BTC。`);
    } else if (latestPrice <= metrics.requiredAverageFromNow) {
      messages.push('现价低于剩余预算所需均价，但高于你的理想目标均价。适合小额定投，不适合一次性打满。');
    } else {
      messages.push('现价高于达标所需均价。为了当前 USDT 仓位完成 1 BTC，当前应只做小额观察单，主力资金等待更低区间。');
    }

    if (boughtBtc > 0 && metrics.currentBuyAverage > metrics.planTargetAverageUsdt) {
      const catchUpPrice = 56000;
      const neededAtCatchUp =
        (metrics.currentBuyAverage * boughtBtc - metrics.planTargetAverageUsdt * boughtBtc) /
        Math.max(1, metrics.planTargetAverageUsdt - catchUpPrice);
      messages.push(`当前后续买入均价高于自动目标。若未来能在 56K 买入，约需 ${btcFormat.format(Math.max(0, neededAtCatchUp))} BTC 才能把后续均价拉回 ${currency.format(metrics.planTargetAverageUsdt)} USDT 附近。`);
    }

    messages.push('建议节奏：75K 以上只记录不追；67K-60K 分批买；59K-56K 加大；52K 以下优先把剩余预算用于补足 1 BTC 缺口。');
    return messages;
  }, [latestPrice, metrics, settings]);

  function updateSetting<K extends keyof PlanSettings>(key: K, value: PlanSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function submitTrade(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.btcAmount <= 0 || draft.priceUsdt <= 0) {
      return;
    }

    setTrades((current) => [
      {
        ...draft,
        id: crypto.randomUUID(),
        feeUsdt: Math.max(0, draft.feeUsdt),
      },
      ...current,
    ]);
    setDraft({ ...defaultTradeDraft(), priceUsdt: Math.round(latestPrice) });
  }

  function deleteTrade(id: string) {
    setTrades((current) => current.filter((trade) => trade.id !== id));
  }

  function resetDemoData() {
    setTrades([]);
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
      </section>

      <section className="layout">
        <div className="panel chart-panel">
          <div className="section-title">
            <div>
              <h2>BTC/USDT K 线</h2>
              <p>{status}</p>
            </div>
            <div className="chart-actions">
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
          <CandlestickChart
            candles={candles}
            trades={trades}
            targetAverage={metrics.planTargetAverageUsdt}
            requiredAverage={metrics.requiredAverageFromNow}
          />
          {error && <div className="chart-error">{error}</div>}
        </div>

        <aside className="panel settings-panel">
          <h2>计划参数</h2>
          <NumberField label="已有 BTC" value={settings.existingBtc} step="0.01" onChange={(value) => updateSetting('existingBtc', value)} />
          <NumberField label="目标 BTC" value={settings.targetBtc} step="0.01" onChange={(value) => updateSetting('targetBtc', value)} />
          <NumberField label="BTC 可用仓位 USDT" value={settings.availableUsdt} step="100" onChange={(value) => updateSetting('availableUsdt', value)} />
          <div className="computed-field">
            <span>自动目标均价</span>
            <strong>{currency.format(metrics.planTargetAverageUsdt)} USDT</strong>
            <small>由可用仓位和目标 BTC 自动推出，不需要手动填。</small>
          </div>
        </aside>
      </section>

      <section className="layout lower-layout">
        <div className="panel">
          <h2>录入交易</h2>
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
              <input value={draft.note} placeholder="例如：59K 计划单 / DCA / 清扫补仓" onChange={(event) => setDraft({ ...draft, note: event.target.value })} />
            </label>
            <button type="submit">保存交易</button>
          </form>
        </div>

        <div className="panel advice-panel">
          <h2>本轮抄底建议</h2>
          {advice.map((item) => (
            <p key={item}>{item}</p>
          ))}
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
                  <tr key={trade.id}>
                    <td>{trade.date}</td>
                    <td><span className={trade.side === 'buy' ? 'buy-tag' : 'sell-tag'}>{trade.side === 'buy' ? '买入' : '卖出'}</span></td>
                    <td>{btcFormat.format(trade.btcAmount)} BTC</td>
                    <td>{currency.format(trade.priceUsdt)} USDT</td>
                    <td>{currency.format(trade.btcAmount * trade.priceUsdt + trade.feeUsdt)} USDT</td>
                    <td>{trade.note || '-'}</td>
                    <td><button className="link-button" onClick={() => deleteTrade(trade.id)}>删除</button></td>
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

function Metric(props: { label: string; value: string; hint: string }) {
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

function CandlestickChart(props: { candles: Candle[]; trades: Trade[]; targetAverage: number; requiredAverage: number }) {
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
  const height = 420;
  const padding = { top: 28, right: 96, bottom: 38, left: 20 };
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

  if (props.candles.length === 0) {
    return <div className="chart-placeholder">正在加载 K 线...</div>;
  }

  const maxVisibleCount = props.candles.length;
  const effectiveVisibleCount = clamp(visibleCount, minVisibleCount, maxVisibleCount);
  const effectiveRightIndex = clamp(rightIndex, Math.min(effectiveVisibleCount - 1, maxVisibleCount - 1), maxVisibleCount - 1);
  const visibleStart = Math.max(0, effectiveRightIndex - effectiveVisibleCount + 1);
  const visibleEnd = effectiveRightIndex;
  const visibleCandles = props.candles.slice(visibleStart, visibleEnd + 1);

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

  const visibleTradePrices = tradeMarkers.map((marker) => marker.trade.priceUsdt);
  const referencePrices = [props.targetAverage, props.requiredAverage || props.targetAverage, ...visibleTradePrices];
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
        {props.requiredAverage > 0 && (
          <>
            <line className="required-line" x1={padding.left} x2={width - padding.right} y1={yScale(props.requiredAverage)} y2={yScale(props.requiredAverage)} />
          </>
        )}
        <line className="target-line" x1={padding.left} x2={width - padding.right} y1={yScale(props.targetAverage)} y2={yScale(props.targetAverage)} />
        {dateTicks.map((index) => (
          <text key={index} className="time-label" x={xScale(index)} y={height - 12} textAnchor={index === visibleEnd ? 'end' : index === visibleStart ? 'start' : 'middle'}>
            {new Date(props.candles[index].time).toLocaleDateString()}
          </text>
        ))}
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
        {tradeMarkers.map(({ trade, index }) => {
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
        {hoveredCandle && (
          <g className="hover-layer">
            <line x1={hoveredX} x2={hoveredX} y1={padding.top} y2={height - padding.bottom} />
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
      <div className="chart-reference-panel">
        <div><i className="required-swatch" />剩余所需均价 <strong>{props.requiredAverage > 0 ? currency.format(props.requiredAverage) : '达标'} USDT</strong></div>
        <div><i className="target-swatch" />自动目标均价 <strong>{currency.format(props.targetAverage)} USDT</strong></div>
      </div>
      <div className="chart-floating-controls">
        <button onClick={() => zoom(0.86)}>+</button>
        <button onClick={() => zoom(1.16)}>-</button>
        <button onClick={jumpToLatest}>最新</button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
