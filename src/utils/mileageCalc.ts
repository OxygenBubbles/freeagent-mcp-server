export interface HMRCRates {
  highPence: number;
  lowPence: number;
  thresholdMiles: number;
}

export type MileageCalcResult =
  | { type: "single"; ratePence: number; amountPounds: string; breakdown: string }
  | {
      type: "split";
      amountPounds: string;
      breakdown: string;
      highMiles: number;
      lowMiles: number;
    };

/**
 * Calculate mileage expense amount using HMRC approved rates with
 * threshold logic (highPence for first thresholdMiles, lowPence thereafter).
 *
 * Rates are injected by the caller so the function stays pure and testable
 * — pass different values here when HMRC updates their rates rather than
 * editing source code.
 *
 * @param miles          Journey miles to claim
 * @param cumulativeYTD  Miles already claimed this tax year (before this journey)
 * @param rates          HMRC rate configuration (see HMRCRates)
 */
export function calculateHMRCMileage(
  miles: number,
  cumulativeYTD: number,
  rates: HMRCRates
): MileageCalcResult {
  const { highPence, lowPence, thresholdMiles } = rates;
  const remaining45p = Math.max(0, thresholdMiles - cumulativeYTD);

  if (remaining45p >= miles) {
    const amountPence = Math.round(miles * highPence);
    return {
      type: "single",
      ratePence: highPence,
      amountPounds: (amountPence / 100).toFixed(2),
      breakdown: `${miles} miles @ ${highPence}p/mile (HMRC)`,
    };
  }

  if (remaining45p <= 0) {
    const amountPence = Math.round(miles * lowPence);
    return {
      type: "single",
      ratePence: lowPence,
      amountPounds: (amountPence / 100).toFixed(2),
      breakdown: `${miles} miles @ ${lowPence}p/mile (HMRC, over ${thresholdMiles.toLocaleString()} threshold)`,
    };
  }

  // Split across threshold
  const highMiles = remaining45p;
  const lowMiles = miles - highMiles;
  const totalPence = Math.round(highMiles * highPence + lowMiles * lowPence);
  return {
    type: "split",
    amountPounds: (totalPence / 100).toFixed(2),
    breakdown: `${highMiles} mi @ ${highPence}p + ${lowMiles} mi @ ${lowPence}p`,
    highMiles,
    lowMiles,
  };
}
