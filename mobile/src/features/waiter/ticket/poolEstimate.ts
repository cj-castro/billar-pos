export type BillingMode = 'PER_MINUTE' | 'ROUND_15' | 'PER_HOUR' | (string & {});

export interface PoolEstimateInput {
  /** Seconds the timer has run (server-clock corrected by the caller). */
  elapsedSeconds: number;
  billingMode: BillingMode;
  /** Cents per HOUR (backend billing.py). */
  rateCents: number;
  promoFreeMinutes?: number | null;
}

/** Client estimate of table time (cents), mirrors backend `calculate_charge`. Display only: the server recomputes on stop. */
export function poolEstimateCents({ elapsedSeconds, billingMode, rateCents, promoFreeMinutes }: PoolEstimateInput): number {
  const secs = Math.max(0, Math.floor(elapsedSeconds) - Math.max(0, promoFreeMinutes ?? 0) * 60);
  if (secs === 0) return 0;
  const perMinute = rateCents / 60;
  switch (billingMode) {
    case 'PER_MINUTE':
      return Math.round((secs / 60) * perMinute);
    case 'ROUND_15':
      return Math.round(Math.ceil(Math.ceil(secs / 60) / 15) * 15 * perMinute);
    case 'PER_HOUR':
      return Math.ceil(secs / 3600) * rateCents;
    default:
      return 0;
  }
}
