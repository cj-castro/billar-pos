import { poolEstimateCents } from '../ticket/poolEstimate';

const base = { rateCents: 6000 }; // $60/h = 100 c/min

describe('poolEstimateCents', () => {
  it('PER_MINUTE is proportional', () => {
    expect(poolEstimateCents({ ...base, billingMode: 'PER_MINUTE', elapsedSeconds: 90 * 60 })).toBe(9000);
    expect(poolEstimateCents({ ...base, billingMode: 'PER_MINUTE', elapsedSeconds: 30 })).toBe(50);
  });
  it('ROUND_15 rounds minutes up to the next quarter hour', () => {
    expect(poolEstimateCents({ ...base, billingMode: 'ROUND_15', elapsedSeconds: 60 })).toBe(1500);
    expect(poolEstimateCents({ ...base, billingMode: 'ROUND_15', elapsedSeconds: 15 * 60 })).toBe(1500);
    expect(poolEstimateCents({ ...base, billingMode: 'ROUND_15', elapsedSeconds: 15 * 60 + 1 })).toBe(3000);
  });
  it('PER_HOUR rounds up to whole hours', () => {
    expect(poolEstimateCents({ ...base, billingMode: 'PER_HOUR', elapsedSeconds: 1 })).toBe(6000);
    expect(poolEstimateCents({ ...base, billingMode: 'PER_HOUR', elapsedSeconds: 3600 })).toBe(6000);
    expect(poolEstimateCents({ ...base, billingMode: 'PER_HOUR', elapsedSeconds: 3601 })).toBe(12000);
  });
  it('subtracts promo free minutes and floors at 0', () => {
    expect(poolEstimateCents({ ...base, billingMode: 'PER_MINUTE', elapsedSeconds: 40 * 60, promoFreeMinutes: 10 })).toBe(3000);
    expect(poolEstimateCents({ ...base, billingMode: 'PER_MINUTE', elapsedSeconds: 5 * 60, promoFreeMinutes: 10 })).toBe(0);
    expect(poolEstimateCents({ ...base, billingMode: 'PER_HOUR', elapsedSeconds: 5 * 60, promoFreeMinutes: 10 })).toBe(0);
  });
  it('unknown mode or negative elapsed is 0', () => {
    expect(poolEstimateCents({ ...base, billingMode: 'X', elapsedSeconds: 600 })).toBe(0);
    expect(poolEstimateCents({ ...base, billingMode: 'PER_MINUTE', elapsedSeconds: -5 })).toBe(0);
  });
});
