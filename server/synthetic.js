// Deterministic synthetic settlement source.
//
// 360 days x 1,200 orders = 432,000 immutable order facts. A derived table
// (`daily_settlement`) rolls them up into 12 monthly partitions. Every
// partition owns a 30-day output window but scans a 120-day source range
// (90-day lookback + its own window), so refunds are attributed by refund date
// and each partition can be rebuilt independently.
//
// Source revisions only append refund events (late refunds, dispute
// chargebacks) - the order facts themselves never change, so two readers of the
// same revision always see identical data. All arithmetic is integer cents and
// every aggregate carries an FNV-style chain checksum, which makes verification
// a real second scan rather than a status flag.

export const SOURCE_VERSIONS = [
  {
    version: 1,
    label: 'v1 · 原始快照',
    detail: '订单 + 常规退款（退款日 3–70 天）',
  },
  {
    version: 2,
    label: 'v2 · 补录迟退单',
    detail: '新增迟退记录（退款日 31–85 天）',
  },
  {
    version: 3,
    label: 'v3 · 补录 + 冲正',
    detail: '新增迟退与争议冲正；冲正退款不再计入',
  },
];

export const DATA = {
  days: 360,
  ordersPerDay: 1200,
  ordersTotal: 432000,
  daysPerPartition: 30,
  partitions: 12,
  lookbackDays: 90,
};

export function hash32(input) {
  let x = input >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

const factsCache = new Map();
const FACTS_CACHE_MAX = 8192;

// Immutable order facts. Refund events are gated by the source revision.
export function orderFacts(index) {
  const cached = factsCache.get(index);
  if (cached) return cached;
  const h = hash32(Math.imul(index + 1, 0x9e3779b1) ^ 0x1f123bb5);
  const h2 = hash32((index ^ 0xa5a5a5a5) >>> 0);
  const h3 = hash32((index ^ 0x51ed270b) >>> 0);
  const day = Math.floor(index / DATA.ordersPerDay);
  const amountCents = 1200 + (h % 28800);

  const facts = {
    index,
    day,
    amountCents,
    region: h % 7,
    // Revision 1: ordinary refunds.
    hasRefund: (h >>> 7) % 100 < 27,
    refundLag: 3 + ((h >>> 13) % 68),
    refundCents: Math.round((amountCents * (1500 + ((h >>> 21) % 8500))) / 10000),
    refundContested: ((h >>> 3) & 15) === 0,
    refundReversed: ((h >>> 2) % 13) === 0,
    // Revision 2: late refunds recovered from an upstream backfill.
    lateAdded: h2 % 9 === 0,
    lateLag: 31 + ((h2 >>> 8) % 55),
    lateCents: Math.round((amountCents * (1000 + ((h2 >>> 16) % 5000))) / 10000),
    lateContested: ((h2 >>> 4) & 7) === 0,
    // Revision 3: a second backfill plus dispute chargebacks.
    extraAdded: h3 % 17 === 0,
    extraLag: 5 + ((h3 >>> 6) % 56),
    extraCents: Math.round((amountCents * (2000 + ((h3 >>> 14) % 6000))) / 10000),
    extraContested: ((h3 >>> 3) & 7) === 0,
  };
  if (factsCache.size >= FACTS_CACHE_MAX) factsCache.clear();
  factsCache.set(index, facts);
  return facts;
}

// cb(refundDay, amountCents, kind, contested, reversed)
export function eachRefund(facts, dataRevision, cb) {
  if (facts.hasRefund) {
    cb(
      facts.day + facts.refundLag,
      facts.refundCents,
      0,
      facts.refundContested,
      dataRevision >= 3 && facts.refundReversed,
    );
  }
  if (dataRevision >= 2 && facts.lateAdded) {
    cb(facts.day + facts.lateLag, facts.lateCents, 1, facts.lateContested, false);
  }
  if (dataRevision >= 3 && facts.extraAdded) {
    cb(facts.day + facts.extraLag, facts.extraCents, 2, facts.extraContested, false);
  }
}

export function partitionDefs() {
  const defs = [];
  for (let i = 0; i < DATA.partitions; i += 1) {
    const no = i + 1;
    const startDay = i * DATA.daysPerPartition;
    const endDay = startDay + DATA.daysPerPartition - 1;
    const lookbackStartDay = Math.max(0, startDay - DATA.lookbackDays);
    const scanStartIndex = lookbackStartDay * DATA.ordersPerDay;
    const scanEndIndex = (endDay + 1) * DATA.ordersPerDay;
    defs.push({
      no,
      index: i,
      startDay,
      endDay,
      lookbackStartDay,
      scanStartIndex,
      scanEndIndex,
      rowsTotal: scanEndIndex - scanStartIndex,
    });
  }
  return defs;
}

export function partitionDef(no) {
  const def = partitionDefs()[no - 1];
  if (!def) throw new Error(`unknown partition ${no}`);
  return def;
}

export function emptyAggregate() {
  return {
    grossCents: 0,
    refundCents: 0,
    feeCents: 0,
    netCents: 0,
    orderCount: 0,
    refundCount: 0,
    rowsScanned: 0,
    checkValue: 0x811c9dc5,
  };
}

function mix(chk, a, b) {
  let x = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  x ^= Math.imul(((b | 0) + 0x165667b1) >>> 0, 0xc2b2ae35) >>> 0;
  x ^= x >>> 15;
  return (Math.imul(chk ^ x, 0x01000193) + 0x27d4eb2f) >>> 0;
}

function feeFor(amountCents, feeBps) {
  return Math.round((amountCents * feeBps) / 10000);
}

// Scan a slice of source orders into `agg`. Build workers call this repeatedly
// on chunks (resumable); verification calls it on the whole range (independent).
export function scanOrders({ startIndex, endIndex, def, dataRevision, rule, agg }) {
  const { windowDays, feeBps, includeContested } = rule;
  for (let i = startIndex; i < endIndex; i += 1) {
    const facts = orderFacts(i);
    if (facts.day >= def.startDay && facts.day <= def.endDay) {
      agg.grossCents += facts.amountCents;
      agg.orderCount += 1;
      agg.checkValue = mix(agg.checkValue, facts.amountCents, i);
    }
    eachRefund(facts, dataRevision, (refundDay, amountCents, kind, contested, reversed) => {
      if (refundDay < def.startDay || refundDay > def.endDay) return;
      if (reversed) return;
      if (contested && !includeContested) return;
      if (refundDay - facts.day > windowDays) return;
      const feeCents = feeFor(amountCents, feeBps);
      agg.refundCents += amountCents;
      agg.feeCents += feeCents;
      agg.refundCount += 1;
      agg.checkValue = mix(agg.checkValue, amountCents, refundDay + kind * 100003);
    });
  }
  agg.rowsScanned += endIndex - startIndex;
  agg.netCents = agg.grossCents - agg.refundCents + agg.feeCents;
  return agg;
}

export const VERIFY_FIELDS = [
  'grossCents',
  'refundCents',
  'feeCents',
  'netCents',
  'orderCount',
  'refundCount',
  'rowsScanned',
  'checkValue',
];

// Combine per-partition checksums into one stable table-level value.
export function sumCheckValues(values) {
  let acc = 0x811c9dc5;
  for (const value of values) {
    acc = Math.imul(acc ^ (value >>> 0), 0x01000193) >>> 0;
    acc = (acc + 0x27d4eb2f) >>> 0;
  }
  return acc >>> 0;
}

export function verifyAggregate(stored, recomputed) {
  const mismatches = [];
  for (const field of VERIFY_FIELDS) {
    if (Number(stored[field]) !== Number(recomputed[field])) {
      mismatches.push({ field, expected: stored[field], actual: recomputed[field] });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

// Complete build of one partition in one call - used for the baseline snapshot
// and for tests. The live engine uses chunked scanOrders with checkpoints.
export function computePartitionFull(no, dataRevision, rule) {
  const def = partitionDef(no);
  const agg = emptyAggregate();
  scanOrders({
    startIndex: def.scanStartIndex,
    endIndex: def.scanEndIndex,
    def,
    dataRevision,
    rule,
    agg,
  });
  return agg;
}

export function ruleToScan(rule) {
  return {
    windowDays: rule.window_days ?? rule.windowDays,
    feeBps: rule.fee_bps ?? rule.feeBps,
    includeContested: Boolean(rule.include_contested ?? rule.includeContested),
  };
}

// Value of the whole table for a source/rule pair (used by the compare view
// fallback and tests).
export function computeTableFull(dataRevision, rule) {
  const totals = emptyAggregate();
  for (const def of partitionDefs()) {
    const agg = computePartitionFull(def.no, dataRevision, rule);
    totals.grossCents += agg.grossCents;
    totals.refundCents += agg.refundCents;
    totals.feeCents += agg.feeCents;
    totals.netCents += agg.netCents;
    totals.orderCount += agg.orderCount;
    totals.refundCount += agg.refundCount;
    totals.rowsScanned += agg.rowsScanned;
  }
  return totals;
}
