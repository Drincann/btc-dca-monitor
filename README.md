# BTC DCA Monitor

用于跟踪本轮 BTC 建仓计划，并把“是否执行下一笔”建立在相对指标、跨周期回测和策略回测上，而不是固定价格或临时判断。

## 当前执行规则

默认动作是继续周定投，不因为单一短周期信号就加速。

可以单独执行下一笔计划内买入的主信号：

- `1D RSI 超卖反转`

需要多周期确认的辅助信号：

- `4H 短跌过度反转`
- `4H RSI 超卖反转`
- `4H 布林下轨放量收回`

`4H 短跌过度反转`中，8% 回撤适合作为观察触发；10% 回撤视为强确认，但需要 1D 或周线配合。

## 操作含义

- 等待：只执行既定周定投，不提高单笔金额。
- 观察：有接近止跌迹象，但等下一根 4H/1D 确认。
- 可买：可以买小到中等一笔，推进计划。
- 加速：可以买下一笔计划内金额，但仍不一次性打满。

## 常用命令

```bash
npm run build
npm run backtest:signals
npm run backtest:strategy
npm run backtest:regimes
npm run backtest:report
npm run verify:policy
npm run verify:runtime
npm run verify:all
```

推荐改规则后的验收命令：

```bash
npm run verify:all
```

`verify:all` 会重新生成报告、校验 policy、构建前端，并用本地行情夹具做运行态截图和像素校验。`backtest:signals`、`backtest:strategy`、`backtest:regimes` 用于重新研究指标和策略，不放进默认验收链路。

## Supabase 云端同步

交易记录默认保存在浏览器 `localStorage`。配置 Supabase 后，页面会显示邮箱 Magic Link 登录，并把交易记录同步到云端；未登录或网络失败时仍保留本地缓存。

接入步骤：

1. 创建 Supabase 项目，区域建议选 Singapore 或 Tokyo。
2. 在 Supabase SQL Editor 执行 `supabase/schema.sql`。
3. 复制 `.env.example` 为 `.env.local`，填入项目的 URL 和 anon key。
4. 本地运行或重新部署页面。

```bash
cp .env.example .env.local
npm run build
```

Auth 使用邮箱 Magic Link 登录。`trade_records` 表开启了 Row Level Security，每个登录用户只能访问自己的交易记录。

## 文件职责

- `shared/market-signals.mjs`：相对抄底信号、候选指标、信号回测。
- `shared/accumulation-strategies.mjs`：周定投、信号预备仓、相对阶梯等策略回测。
- `shared/decision-policy.mjs`：主信号、强确认、信号分级和参数敏感性摘要。
- `scripts/market-data.mjs`：回测行情源，默认 Binance 长样本，CryptoCompare 兜底。
- `scripts/generate-backtest-report.mjs`：生成 `reports/backtest-report.md` 和 `reports/backtest-report.json`，包含信号排名、样本外验证、参数敏感性和策略回测。
- `scripts/verify-backtest-policy.mjs`：验证报告、前端 policy、主信号、样本外表现和固定价格残留。
- `scripts/verify-runtime-page.mjs`：启动临时页面，用本地行情夹具截图并检查 K 线和抄底标记像素。
- `src/trade-cloud-sync.ts`：Supabase Auth 和交易记录云端同步封装。
- `src/main.tsx`：监控台 UI、交易记录、本轮执行决策。

## 关键约束

- 不把固定价格作为信号输入。
- 信号只用于判断下一笔，不替代完成 1 BTC 的定投纪律。
- 4H 单独信号不自动加速，需要 1D 或 1W 配合。
- 报告和前端必须共用 `shared/decision-policy.mjs`，避免两套规则漂移。
