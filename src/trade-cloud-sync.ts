import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

export type PersistedTrade = {
  id: string;
  date: string;
  side: 'buy' | 'sell';
  btcAmount: number;
  priceUsdt: number;
  note: string;
};

export type TradeCloudUser = {
  id: string;
  email: string;
};

type TradeRecordRow = {
  id: string;
  user_id: string;
  trade_date: string;
  side: 'buy' | 'sell';
  btc_amount: number | string;
  price_usdt: number | string;
  note: string | null;
};

const tradeRecordTable = 'trade_records';

function requireNoError(error: unknown) {
  if (!error) {
    return;
  }

  const message = error instanceof Error ? error.message : 'Supabase 请求失败';
  throw new Error(message);
}

function tradeFromRow(row: TradeRecordRow): PersistedTrade {
  return {
    id: row.id,
    date: row.trade_date,
    side: row.side,
    btcAmount: Number(row.btc_amount),
    priceUsdt: Number(row.price_usdt),
    note: row.note ?? '',
  };
}

function rowFromTrade(trade: PersistedTrade, userId: string): TradeRecordRow {
  return {
    id: trade.id,
    user_id: userId,
    trade_date: trade.date,
    side: trade.side,
    btc_amount: trade.btcAmount,
    price_usdt: trade.priceUsdt,
    note: trade.note,
  };
}

function userFromSession(session: { user: { id: string; email?: string } } | null): TradeCloudUser | null {
  if (!session?.user.email) {
    return null;
  }

  return {
    id: session.user.id,
    email: session.user.email,
  };
}

export class TradeCloudSync {
  private readonly client: SupabaseClient;

  constructor(url: string, anonKey: string) {
    this.client = createClient(url, anonKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
      },
    });
  }

  async currentUser() {
    const { data, error } = await this.client.auth.getSession();
    requireNoError(error);
    return userFromSession(data.session);
  }

  onUserChange(callback: (user: TradeCloudUser | null) => void) {
    const { data } = this.client.auth.onAuthStateChange((_event, session) => {
      callback(userFromSession(session));
    });

    return () => data.subscription.unsubscribe();
  }

  async sendLoginLink(email: string, redirectTo: string) {
    const { error } = await this.client.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: redirectTo,
        shouldCreateUser: true,
      },
    });
    requireNoError(error);
  }

  async signOut() {
    const { error } = await this.client.auth.signOut();
    requireNoError(error);
  }

  async listTrades() {
    const { data, error } = await this.client
      .from(tradeRecordTable)
      .select('id,user_id,trade_date,side,btc_amount,price_usdt,note')
      .order('trade_date', { ascending: false })
      .order('created_at', { ascending: false });
    requireNoError(error);

    return ((data ?? []) as TradeRecordRow[]).map(tradeFromRow);
  }

  async saveTrade(trade: PersistedTrade, user: TradeCloudUser) {
    const { error } = await this.client.from(tradeRecordTable).upsert(rowFromTrade(trade, user.id));
    requireNoError(error);
  }

  async saveTrades(trades: PersistedTrade[], user: TradeCloudUser) {
    if (trades.length === 0) {
      return;
    }

    const { error } = await this.client.from(tradeRecordTable).upsert(trades.map((trade) => rowFromTrade(trade, user.id)));
    requireNoError(error);
  }

  async deleteTrade(id: string) {
    const { error } = await this.client.from(tradeRecordTable).delete().eq('id', id);
    requireNoError(error);
  }

  async deleteTrades(ids: string[]) {
    if (ids.length === 0) {
      return;
    }

    const { error } = await this.client.from(tradeRecordTable).delete().in('id', ids);
    requireNoError(error);
  }
}

export function createTradeCloudSync() {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    return null;
  }

  return new TradeCloudSync(url, anonKey);
}
