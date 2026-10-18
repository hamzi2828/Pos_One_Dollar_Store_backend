// Straight-line depreciation, counted in FULL months since the purchase date.
//   monthly = (cost - salvage) / (usefulLifeYears * 12)
//   accumulated = monthly * monthsUsed  (never more than cost - salvage)
//   currentValue = cost - accumulated
// Method 'none' (or no useful life): the value stays at cost.
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Full months from `from` to `to` (UTC dates; 15 Jan -> 14 Feb = 0, -> 15 Feb = 1). */
function fullMonths(from, to) {
  if (!from || !to) return 0;
  const a = new Date(from);
  const b = new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b <= a) return 0;
  let m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) m -= 1;
  return Math.max(0, m);
}

/**
 * @param {object} p
 * @param {number} p.cost           total cost (unit price x quantity)
 * @param {number} [p.salvage=0]    total salvage value at the end of the life
 * @param {number} [p.lifeYears]
 * @param {'straight_line'|'none'} [p.method]
 * @param {Date}   p.purchaseDate
 * @param {Date}   [p.asOf=now]     value on this date (disposal date for sold assets)
 */
function depreciate({ cost, salvage = 0, lifeYears, method, purchaseDate, asOf = new Date() }) {
  const c = round2(Math.max(0, Number(cost) || 0));
  const s = Math.min(c, round2(Math.max(0, Number(salvage) || 0)));
  const months = fullMonths(purchaseDate, asOf);
  const life = Number(lifeYears) || 0;
  if (method !== 'straight_line' || life <= 0) {
    return { method: 'none', monthsUsed: months, lifeMonths: null, monthly: 0, accumulated: 0, currentValue: c, fullyDepreciated: false };
  }
  const lifeMonths = Math.max(1, Math.round(life * 12));
  const depreciable = c - s;
  const monthly = depreciable / lifeMonths;
  const used = Math.min(months, lifeMonths);
  const accumulated = round2(Math.min(depreciable, monthly * used));
  return {
    method: 'straight_line',
    monthsUsed: months,
    lifeMonths,
    monthly: round2(monthly),
    accumulated,
    currentValue: round2(c - accumulated),
    fullyDepreciated: months >= lifeMonths,
  };
}

module.exports = { depreciate, fullMonths, round2 };
