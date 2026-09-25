// ============================================================================
// lib/peak.mjs —— DeepSeek 峰谷计费时段判定（宿主端与前端共用的唯一真源）
// ============================================================================
// 官方规则（https://api-docs.deepseek.com/zh-cn/quick_start/pricing）：
//   「空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）
//     9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日
//     全天均为空闲时段。」
//
// 因此：
//   高峰（峰）= 北京时间 周一~周五 且 非法定节假日 且 (9:00–12:00 或 14:00–18:00)
//   空闲（谷）= 其余全部时间（含周末、法定节假日全天、以及工作日的其它时段）
// ============================================================================

/** 高峰时段：北京时间整点区间 [start, end)。 */
export const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]

/**
 * 法定节假日（全天按谷价）。key 为北京日历日 YYYY-MM-DD。
 * 依据《国务院办公厅关于 2026 年部分节假日安排的通知》。
 * 只列「放假」的日期：调休上班日全部落在周末，按「周末也算谷价」本就在谷时。
 * ⚠️ 每年 11 月国务院公布次年安排后，需要在这里补下一年度的日期。
 */
export const HOLIDAY_VALLEY = {
  '2026-01-01': 1, '2026-01-02': 1, '2026-01-03': 1, // 元旦
  '2026-02-15': 1, '2026-02-16': 1, '2026-02-17': 1, '2026-02-18': 1, // 春节
  '2026-02-19': 1, '2026-02-20': 1, '2026-02-21': 1, '2026-02-22': 1, '2026-02-23': 1,
  '2026-04-04': 1, '2026-04-05': 1, '2026-04-06': 1, // 清明
  '2026-05-01': 1, '2026-05-02': 1, '2026-05-03': 1, '2026-05-04': 1, '2026-05-05': 1, // 劳动节
  '2026-06-19': 1, '2026-06-20': 1, '2026-06-21': 1, // 端午
  '2026-09-25': 1, '2026-09-26': 1, '2026-09-27': 1, // 中秋
  '2026-10-01': 1, '2026-10-02': 1, '2026-10-03': 1, '2026-10-04': 1, // 国庆
  '2026-10-05': 1, '2026-10-06': 1, '2026-10-07': 1,
}

/** 下发给前端的节假日清单（前端不重复维护一份日历）。 */
export const HOLIDAY_VALLEY_LIST = Object.keys(HOLIDAY_VALLEY).sort()

const BEIJING_OFFSET_SEC = 8 * 3600

/**
 * 把 epoch 秒换算成「北京日历」的日期分量。
 * 做法：把时间平移 +8h 后按 UTC 读取，读到的就是北京本地日历。
 * @param {number} timeSec epoch 秒
 */
export function beijingParts(timeSec) {
  const n = Number(timeSec)
  if (!Number.isFinite(n)) return null
  const bj = new Date(n * 1000 + BEIJING_OFFSET_SEC * 1000)
  return {
    year: bj.getUTCFullYear(),
    month: bj.getUTCMonth() + 1,
    day: bj.getUTCDate(),
    hour: bj.getUTCHours(),
    minute: bj.getUTCMinutes(),
    /** 0=周日 … 6=周六 */
    dow: bj.getUTCDay(),
    date: bj.toISOString().slice(0, 10),
  }
}

/**
 * 是否为 DeepSeek 高峰计费时段。
 * @param {number} timeSec epoch 秒
 * @returns {boolean} true=高峰(峰)，false=空闲(谷)
 */
export function isPeakTime(timeSec) {
  const p = beijingParts(timeSec)
  if (p === null) return false
  // 周末全天谷价
  if (p.dow === 0 || p.dow === 6) return false
  // 法定节假日全天谷价
  if (HOLIDAY_VALLEY[p.date]) return false
  for (const [start, end] of PEAK_HOURS) {
    if (p.hour >= start && p.hour < end) return true
  }
  return false
}

/**
 * 下一个峰谷切换时刻（epoch 秒）。与 isPeakTime 完全同源。
 * 只需扫北京时间的切换边界 0/9/12/14/18 点；扫 400 天以覆盖任何长假/跨年。
 * @param {number} timeSec
 * @returns {number|null} null 表示 400 天内没有切换点
 */
export function nextPeakChangeAt(timeSec) {
  const n = Number(timeSec)
  if (!Number.isFinite(n)) return null
  const current = isPeakTime(n)
  const day0 = Math.floor((n + BEIJING_OFFSET_SEC) / 86400) * 86400
  for (let d = 0; d <= 400; d++) {
    for (const edge of [0, 9, 12, 14, 18]) {
      const cand = day0 + d * 86400 + edge * 3600 - BEIJING_OFFSET_SEC
      if (cand <= n + 1) continue
      if (isPeakTime(cand) !== current) return cand
    }
  }
  return null
}

/**
 * 给前端用的时段快照。
 * @param {number} [nowSec]
 */
export function peakSnapshot(nowSec) {
  const now = Number.isFinite(Number(nowSec)) ? Math.floor(Number(nowSec)) : Math.floor(Date.now() / 1000)
  const next = nextPeakChangeAt(now)
  const p = beijingParts(now)
  return {
    isPeak: isPeakTime(now),
    label: isPeakTime(now) ? '峰' : '谷',
    text: isPeakTime(now) ? '高峰时段' : '空闲时段',
    nextChangeAt: next,
    date: p ? p.date : null,
    hour: p ? p.hour : null,
    peakHours: PEAK_HOURS.map(([a, b]) => `${a}:00-${b}:00`),
    holidays: HOLIDAY_VALLEY_LIST,
    serverTime: now,
  }
}
