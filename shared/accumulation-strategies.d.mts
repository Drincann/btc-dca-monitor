import type { Candle } from './market-signals.mjs';

export type AccumulationTrade = {
  dayIndex: number;
  btcAmount: number;
  price: number;
};

export type AccumulationResult = {
  totalBtc: number;
  averagePrice: number;
  totalCost: number;
  efficiency: number;
  completed: boolean;
};

export type AccumulationBacktest = {
  samples: number;
  rows: Array<{
    name: string;
    key: string;
    averageEntry: number;
    medianEntry: number;
    averageEfficiency: number;
    p25Efficiency: number;
    completionRate: number;
  }>;
};

export type AccumulationStrategy = {
  name: string;
  key: string;
  run: (candles: Candle[], startIndex: number, windowCandles: Candle[], targetBtc: number) => AccumulationResult;
};

export const defaultWindowDays: number;
export const accumulationStrategies: AccumulationStrategy[];

export function summarizeAccumulationTrades(
  windowCandles: Candle[],
  trades: AccumulationTrade[],
  targetBtc: number,
): AccumulationResult;
export function bearAccumulationWindow(candles: Candle[], startIndex: number, windowDays?: number): boolean;
export function weeklyDcaStrategy(candles: Candle[], startIndex: number, windowCandles: Candle[], targetBtc: number): AccumulationResult;
export function signalReserveStrategy(candles: Candle[], startIndex: number, windowCandles: Candle[], targetBtc: number): AccumulationResult;
export function relativeLadderStrategy(candles: Candle[], startIndex: number, windowCandles: Candle[], targetBtc: number): AccumulationResult;
export function blendedLadderReserveStrategy(candles: Candle[], startIndex: number, windowCandles: Candle[], targetBtc: number): AccumulationResult;
export function evaluateAccumulationStrategies(
  candles: Candle[],
  targetBtc: number,
  options?: { windowDays?: number; startStepDays?: number },
): AccumulationBacktest | null;
