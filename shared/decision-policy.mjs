export const primarySignalRules = [
  { interval: '1d', label: '1D', signalName: 'RSI 超卖反转', reportName: 'RSI超卖反转' },
];

export const confirmationSignalRules = [
  { interval: '4h', label: '4H', signalName: '短跌过度反转', reportName: '短跌过度反转' },
];

export function isPrimaryBottomSignal(row) {
  if (row.signal?.action !== 'buy') {
    return false;
  }

  return primarySignalRules.some((rule) => row.label === rule.label && row.signal.signalName === rule.signalName);
}

export function isStrongFourHourDropSignal(row) {
  return (
    row.label === '4H' &&
    row.signal?.action === 'buy' &&
    row.signal.signalName === '短跌过度反转' &&
    row.signal.sevenDayDrawdown <= -0.1
  );
}

export function classifyBacktestedSignal(result) {
  const h14 = result.horizonStats.find((item) => item.days === 14);
  const h30 = result.horizonStats.find((item) => item.days === 30);
  const stability = result.stability;

  if (!h14 || !h30 || h14.samples < 8) {
    return '样本不足，只能观察';
  }
  if (result.interval === '4h' && result.name === '短跌过度反转') {
    return '需多周期确认';
  }
  if (result.score > 0.02 && h14.averageReturn > 0 && h30.averageReturn > 0 && stability?.positiveYearRate >= 0.65 && stability.worstYearReturn > -0.05) {
    return '可作为下一笔买入确认';
  }
  if (result.score > 0.02 && h14.averageReturn > 0 && h30.averageReturn > 0 && stability?.positiveYearRate >= 0.5) {
    return '需多周期确认';
  }
  if (h14.averageReturn > 0 || h30.averageReturn > 0) {
    return '只作辅助，不单独触发';
  }
  return '暂不采用';
}

export function summarizeParameterSensitivity(sensitivity) {
  return sensitivity
    .map((item) => {
      const baselineScore = item.baseline?.score ?? -Infinity;
      const bestScore = item.best?.score ?? -Infinity;
      if (!Number.isFinite(baselineScore) || !Number.isFinite(bestScore)) {
        return `${item.signal} 参数样本不足，暂不调整。`;
      }
      const gap = bestScore - baselineScore;
      if (gap < 0.01) {
        return `${item.signal} 当前阈值处在稳定区间，不需要追逐单点最优。`;
      }
      if (item.signal === '4H 短跌过度反转') {
        return `${item.signal} 8%回撤适合作为观察触发，10%回撤可视为强确认，但需要 1D 或周线配合。`;
      }
      return `${item.signal} 存在更优参数，但提升有限，先保留当前阈值，后续观察。`;
    })
    .join(' ');
}

export function primarySignalSummary() {
  return '当前唯一主触发是 1D RSI 超卖反转；4H 短跌过度反转只作为确认信号，单独出现时不加速。';
}
