export interface UserBudgetEnvelope {
  spaceId: string;
  userId: string;
  dailyCreditAllowance: number;
  creditsSpentToday: number;
  hardStopEnabled: boolean;
  warnedAtEighty: boolean;
  resetAt: string;
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: "USER_BUDGET_EXCEEDED" | "RESERVE_FLOOR_BREACH" | "INSUFFICIENT_FUNDS";
  remainingUserCredits: number;
  remainingWalletCredits: number;
  requiresSoftWarning?: boolean;
}

export const CORPORATE_RESERVE_PERCENT = 0.40; // 40% of wallet reserved for Class 1 automations
export const DEFAULT_USER_DAILY_CREDITS = 500;  // 500 credits = $5.00

/**
 * Pure evaluation function for user budget envelope compliance
 */
export function evaluateUserBudget(
  envelope: UserBudgetEnvelope,
  requestedCredits: number,
  walletBalanceCredits: number,
  isClass1Automation: boolean = false
): BudgetCheckResult {
  // 1. System Class 1 Automations bypass user envelopes
  if (isClass1Automation) {
    const hasFunds = walletBalanceCredits >= requestedCredits;
    return {
      allowed: hasFunds,
      reason: hasFunds ? undefined : "INSUFFICIENT_FUNDS",
      remainingUserCredits: Infinity,
      remainingWalletCredits: walletBalanceCredits - requestedCredits,
    };
  }

  // 2. Evaluate User Daily Envelope
  const projectedUserSpend = envelope.creditsSpentToday + requestedCredits;
  if (envelope.hardStopEnabled && projectedUserSpend > envelope.dailyCreditAllowance) {
    return {
      allowed: false,
      reason: "USER_BUDGET_EXCEEDED",
      remainingUserCredits: Math.max(0, envelope.dailyCreditAllowance - envelope.creditsSpentToday),
      remainingWalletCredits: walletBalanceCredits,
    };
  }

  // 3. Evaluate 40% Corporate Reserve Floor
  const reserveFloor = Math.round(walletBalanceCredits * CORPORATE_RESERVE_PERCENT);
  const remainingAfterDebit = walletBalanceCredits - requestedCredits;
  if (remainingAfterDebit < reserveFloor) {
    return {
      allowed: false,
      reason: "RESERVE_FLOOR_BREACH",
      remainingUserCredits: Math.max(0, envelope.dailyCreditAllowance - envelope.creditsSpentToday),
      remainingWalletCredits: walletBalanceCredits,
    };
  }

  // 4. Check for 80% soft warning threshold
  const eightyPercentThreshold = envelope.dailyCreditAllowance * 0.80;
  const requiresSoftWarning = !envelope.warnedAtEighty && projectedUserSpend >= eightyPercentThreshold;

  return {
    allowed: true,
    remainingUserCredits: envelope.dailyCreditAllowance - projectedUserSpend,
    remainingWalletCredits: remainingAfterDebit,
    requiresSoftWarning,
  };
}
