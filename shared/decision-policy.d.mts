import type { BottomSignal, SignalHorizonStats } from './market-signals.mjs';

export type TimeframeSignalLike = {
  label: string;
  signal: BottomSignal | null;
};

export type BacktestedSignalLike = {
  score: number;
  horizonStats: SignalHorizonStats[];
  stability?: {
    positiveYearRate: number;
    worstYearReturn: number;
  };
};

export type ParameterSensitivityLike = {
  signal: string;
  baseline?: { score: number };
  best?: { score: number };
};

export const primarySignalRules: Array<{
  interval: string;
  label: string;
  signalName: string;
  reportName: string;
}>;

export function isPrimaryBottomSignal(row: TimeframeSignalLike): boolean;
export function isStrongFourHourDropSignal(row: TimeframeSignalLike): boolean;
export function classifyBacktestedSignal(result: BacktestedSignalLike): string;
export function summarizeParameterSensitivity(sensitivity: ParameterSensitivityLike[]): string;
export function primarySignalSummary(): string;
