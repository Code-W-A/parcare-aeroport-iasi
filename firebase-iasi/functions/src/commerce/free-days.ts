import type { FreeDayState, LoyaltyRecord } from "../contracts";
export const zeroFreeDays = (): FreeDayState => ({
  points: 0,
  progress: 0,
  available: 0,
  reserved: 0,
  debt: 0,
});
export function initializeFreeDays(customer: LoyaltyRecord): LoyaltyRecord {
  if (customer.freeDays)
    return { ...customer, freeDays: { ...customer.freeDays } };
  return {
    ...customer,
    freeDays: zeroFreeDays(),
    legacyLoyalty: {
      points: customer.points,
      benefitStatus: customer.benefitStatus,
    },
  };
}
export function earnDay(state: FreeDayState, threshold: number): FreeDayState {
  const s = { ...state, points: state.points + 1 };
  if (s.debt > 0) s.debt--;
  else s.progress++;
  while (s.progress >= threshold) {
    s.progress -= threshold;
    s.available++;
  }
  return s;
}
export function reverseDay(
  state: FreeDayState,
  threshold: number,
): FreeDayState {
  const s = { ...state, points: Math.max(0, state.points - 1) };
  if (s.progress > 0) s.progress--;
  else if (s.available > 0) {
    s.available--;
    s.progress = threshold - 1;
  } else s.debt++;
  return s;
}
