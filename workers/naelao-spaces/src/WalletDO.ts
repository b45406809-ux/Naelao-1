import { DurableObject } from 'cloudflare:workers';

interface Env {
  PLATFORM_DAILY_CREDIT_CEILING?: string;
}

export class WalletDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    state.blockConcurrencyWhile(() => this.initSchema());
  }

  private initSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY DEFAULT 0)`);
    this.sql.exec(`INSERT OR IGNORE INTO schema_version VALUES (0)`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS wallet (
      id TEXT PRIMARY KEY,
      balance_credits INTEGER DEFAULT 0,
      daily_spent INTEGER DEFAULT 0,
      daily_reset_at TEXT,
      monthly_spent INTEGER DEFAULT 0,
      monthly_reset_at TEXT,
      lifetime_spent INTEGER DEFAULT 0,
      updated_at TEXT
    )`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      wallet_id TEXT,
      amount INTEGER,
      created_at TEXT,
      expires_at TEXT
    )`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      wallet_id TEXT,
      type TEXT,
      amount INTEGER,
      reason TEXT,
      run_id TEXT,
      created_at TEXT
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_txn_wallet ON transactions(wallet_id, created_at DESC)`);
  }

  private platformCeiling(): number {
    return parseInt(this.env.PLATFORM_DAILY_CREDIT_CEILING ?? '500000', 10);
  }

  private resetDailyIfNeeded(walletId: string): void {
    const w = [...this.sql.exec<{ daily_reset_at: string | null }>(
      `SELECT daily_reset_at FROM wallet WHERE id = ?`, walletId
    )][0];
    if (!w) return;
    const today = new Date().toISOString().split('T')[0]!;
    const resetDay = w.daily_reset_at?.split('T')[0];
    if (!resetDay || resetDay < today) {
      this.sql.exec(
        `UPDATE wallet SET daily_spent = 0, daily_reset_at = ? WHERE id = ?`,
        new Date().toISOString(), walletId
      );
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/reserve': return this.handleReserve(request);
        case '/settle': return this.handleSettle(request);
        case '/deduct': return this.handleDeduct(request);
        case '/add': return this.handleAdd(request);
        case '/balance': return this.handleBalance(url);
        case '/transactions': return this.handleTransactions(url);
        case '/sweep-reservations': return this.handleSweepReservations();
        default:
          return Response.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, { status: 404 });
      }
    } catch (e) {
      return Response.json({ error: { code: 'INTERNAL_ERROR', message: String(e) } }, { status: 500 });
    }
  }

  private async handleReserve(request: Request): Promise<Response> {
    const { walletId, amount } = await request.json<{ walletId: string; amount: number }>();
    this.resetDailyIfNeeded(walletId);

    const w = [...this.sql.exec<{ balance_credits: number; daily_spent: number }>(
      `SELECT balance_credits, daily_spent FROM wallet WHERE id = ?`, walletId
    )][0];

    if (!w) {
      return Response.json({ error: { code: 'WALLET_NOT_FOUND', message: 'Wallet not found' } }, { status: 404 });
    }

    if (w.daily_spent + amount > this.platformCeiling()) {
      return Response.json({ data: { success: false, reason: 'platform_daily_limit_exceeded' } });
    }

    if (w.balance_credits < amount) {
      return Response.json({ data: { success: false, reason: 'insufficient_balance' } });
    }

    const reservationId = crypto.randomUUID();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 300_000).toISOString();

    this.sql.exec(
      `UPDATE wallet SET balance_credits = balance_credits - ?, updated_at = ? WHERE id = ?`,
      amount, now, walletId
    );
    this.sql.exec(
      `INSERT INTO reservations (id, wallet_id, amount, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      reservationId, walletId, amount, now, expiresAt
    );
    this.sql.exec(
      `INSERT INTO transactions (id, wallet_id, type, amount, reason, created_at) VALUES (?, ?, 'reserve', ?, 'reservation', ?)`,
      crypto.randomUUID(), walletId, amount, now
    );

    return Response.json({ data: { reservationId } });
  }

  private async handleSettle(request: Request): Promise<Response> {
    const { reservationId, actual } = await request.json<{ reservationId: string; actual: number }>();
    const now = new Date().toISOString();

    const res = [...this.sql.exec<{ wallet_id: string; amount: number }>(
      `SELECT wallet_id, amount FROM reservations WHERE id = ?`, reservationId
    )][0];

    if (!res) {
      return Response.json({ error: { code: 'RESERVATION_NOT_FOUND', message: 'Reservation not found' } }, { status: 404 });
    }

    const refund = Math.max(0, res.amount - actual);
    if (refund > 0) {
      this.sql.exec(
        `UPDATE wallet SET balance_credits = balance_credits + ?, daily_spent = daily_spent + ?, updated_at = ? WHERE id = ?`,
        refund, actual, now, res.wallet_id
      );
    } else {
      this.sql.exec(
        `UPDATE wallet SET daily_spent = daily_spent + ?, updated_at = ? WHERE id = ?`,
        actual, now, res.wallet_id
      );
    }

    this.sql.exec(`DELETE FROM reservations WHERE id = ?`, reservationId);
    this.sql.exec(
      `INSERT INTO transactions (id, wallet_id, type, amount, reason, created_at) VALUES (?, ?, 'settle', ?, 'reservation_settled', ?)`,
      crypto.randomUUID(), res.wallet_id, actual, now
    );

    const updated = [...this.sql.exec<{ balance_credits: number }>(
      `SELECT balance_credits FROM wallet WHERE id = ?`, res.wallet_id
    )][0];

    return Response.json({ data: { balance: updated?.balance_credits ?? 0 } });
  }

  private async handleDeduct(request: Request): Promise<Response> {
    const { walletId, amount, reason } = await request.json<{ walletId: string; amount: number; reason: string }>();
    this.resetDailyIfNeeded(walletId);

    const w = [...this.sql.exec<{ balance_credits: number; daily_spent: number }>(
      `SELECT balance_credits, daily_spent FROM wallet WHERE id = ?`, walletId
    )][0];

    if (!w) return Response.json({ data: { success: false, balance: 0 } });
    if (w.daily_spent + amount > this.platformCeiling()) {
      return Response.json({ data: { success: false, reason: 'platform_daily_limit_exceeded', balance: w.balance_credits } });
    }
    if (w.balance_credits < amount) {
      return Response.json({ data: { success: false, reason: 'insufficient_balance', balance: w.balance_credits } });
    }

    const now = new Date().toISOString();
    this.sql.exec(
      `UPDATE wallet SET balance_credits = balance_credits - ?, daily_spent = daily_spent + ?, updated_at = ? WHERE id = ?`,
      amount, amount, now, walletId
    );
    this.sql.exec(
      `INSERT INTO transactions (id, wallet_id, type, amount, reason, created_at) VALUES (?, ?, 'deduct', ?, ?, ?)`,
      crypto.randomUUID(), walletId, amount, reason, now
    );

    const updated = [...this.sql.exec<{ balance_credits: number }>(
      `SELECT balance_credits FROM wallet WHERE id = ?`, walletId
    )][0];

    return Response.json({ data: { success: true, balance: updated?.balance_credits ?? 0 } });
  }

  private async handleAdd(request: Request): Promise<Response> {
    const { walletId, amount, reason } = await request.json<{ walletId: string; amount: number; reason: string }>();
    const now = new Date().toISOString();

    const existing = [...this.sql.exec<{ id: string }>(`SELECT id FROM wallet WHERE id = ?`, walletId)][0];
    if (!existing) {
      this.sql.exec(
        `INSERT INTO wallet (id, balance_credits, daily_spent, daily_reset_at, monthly_spent, monthly_reset_at, lifetime_spent, updated_at)
         VALUES (?, ?, 0, ?, 0, ?, 0, ?)`,
        walletId, amount, now, now, now
      );
    } else {
      this.sql.exec(
        `UPDATE wallet SET balance_credits = balance_credits + ?, lifetime_spent = lifetime_spent + ?, updated_at = ? WHERE id = ?`,
        amount, 0, now, walletId
      );
    }

    this.sql.exec(
      `INSERT INTO transactions (id, wallet_id, type, amount, reason, created_at) VALUES (?, ?, 'add', ?, ?, ?)`,
      crypto.randomUUID(), walletId, amount, reason, now
    );

    const updated = [...this.sql.exec<{ balance_credits: number }>(`SELECT balance_credits FROM wallet WHERE id = ?`, walletId)][0];
    return Response.json({ data: { balance: updated?.balance_credits ?? 0 } });
  }

  private handleBalance(url: URL): Response {
    const walletId = url.searchParams.get('walletId') ?? '';
    const w = [...this.sql.exec<{ balance_credits: number; daily_spent: number; monthly_spent: number }>(
      `SELECT balance_credits, daily_spent, monthly_spent FROM wallet WHERE id = ?`, walletId
    )][0];
    return Response.json({ data: { balance: w?.balance_credits ?? 0, dailySpent: w?.daily_spent ?? 0, monthlySpent: w?.monthly_spent ?? 0 } });
  }

  private handleTransactions(url: URL): Response {
    const walletId = url.searchParams.get('walletId') ?? '';
    const cursor = url.searchParams.get('cursor');
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    let query = `SELECT * FROM transactions WHERE wallet_id = ?`;
    const params: unknown[] = [walletId];
    if (cursor) { query += ` AND id < ?`; params.push(cursor); }
    query += ` ORDER BY id DESC LIMIT ?`;
    params.push(limit);
    const txns = [...this.sql.exec<Record<string, unknown>>(query, ...params)];
    const nextCursor = txns.length === limit ? (txns[txns.length - 1]?.['id'] as string | undefined) : undefined;
    return Response.json({ data: { transactions: txns, nextCursor } });
  }

  private handleSweepReservations(): Response {
    const now = new Date().toISOString();
    const expired = [...this.sql.exec<{ id: string; wallet_id: string; amount: number }>(
      `SELECT id, wallet_id, amount FROM reservations WHERE expires_at < ?`, now
    )];

    for (const res of expired) {
      this.sql.exec(
        `UPDATE wallet SET balance_credits = balance_credits + ?, updated_at = ? WHERE id = ?`,
        res.amount, now, res.wallet_id
      );
      this.sql.exec(`DELETE FROM reservations WHERE id = ?`, res.id);
    }

    return Response.json({ data: { expired: expired.length } });
  }
}
