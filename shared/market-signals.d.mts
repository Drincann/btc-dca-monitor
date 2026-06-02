export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type BottomSignal = {
  time: number;
  action: 'wait' | 'watch' | 'buy';
  title: string;
  summary: string;
  signalName: string;
  sevenDayDrawdown: number;
  rsi14: number;
  rsiRising: boolean;
  deepPullback: boolean;
  bullishReversal: boolean;
  closeRecovered: boolean;
  latestClose: number;
  latestLow: number;
};

export type SignalHorizonStats = {
  days: number;
  samples: number;
  winRate: number;
  averageReturn: number;
  medianReturn: number;
  p25Return: number;
};

export type SignalBacktest = {
  totalSignals: number;
  latestSignalDate: string;
  horizons: SignalHorizonStats[];
};

export type SignalCandidate = {
  name: string;
  minBars: number;
  withIndicators?: (candles: Candle[]) => Record<string, Array<number | null>>;
  signal: (candles: Candle[], index: number, indicators: Record<string, Array<number | null>>) => boolean;
};

export type SignalCandidateResult = {
  interval: string;
  name: string;
  signals: number;
  latestSignal: string;
  horizonStats: SignalHorizonStats[];
};

export const signalHorizons: number[];
export const signalCandidateDefinitions: SignalCandidate[];

export function average(values: number[]): number;
export function percentile(values: number[], percentileValue: number): number;
export function standardDeviation(values: number[]): number;
export function rolling(candles: Candle[], index: number, period: number): Candle[];
export function closePosition(candle: Candle): number;
export function calculateRsiAt(candles: Candle[], index: number, period?: number): number | null;
export function calculateRsiSeries(candles: Candle[], period?: number): Array<number | null>;
export function trendIsCooling(candles: Candle[], index: number): boolean;
export function trendAllowsSignal(candles: Candle[], index: number): boolean;
export function analyzeBottomSignalAt(candles: Candle[], index: number): BottomSignal | null;
export function analyzeBottomSignal(candles: Candle[]): BottomSignal | null;
export function collectBottomSignals(candles: Candle[], minGapBars?: number): BottomSignal[];
export function backtestBottomSignals(candles: Candle[], horizons?: number[], barsPerDay?: number): SignalBacktest;
export function cooldownSignalIndexes(candles: Candle[], candidate: SignalCandidate, cooldownBars?: number): number[];
export function evaluateSignalCandidate(
  candles: Candle[],
  interval: string,
  candidate: SignalCandidate,
  barsPerDay: number,
  horizons?: number[],
): SignalCandidateResult;
export function scoreSignalResult(result: SignalCandidateResult): number;
