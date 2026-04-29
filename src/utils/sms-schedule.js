const { DateTime } = require('luxon');

const DEFAULT_TZ = 'America/New_York';

/** Luxon weekday 1=Monday … 7=Sunday — matches Postgres ISO dow if we use JS Date.getDay differently; Luxon is ISO. */
function parseHm(t) {
  const m = String(t || '09:00').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { h: 9, min: 0 };
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const min = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return { h, min };
}

/**
 * Next instant >= `from` when sending is allowed (weekday + time-of-day window).
 * @param {object} campaign — timezone, schedule_days (int[] 1-7), schedule_start, schedule_end
 * @param {Date} from
 * @returns {Date}
 */
function nextAllowedSendAt(campaign, from = new Date()) {
  const tz = String(campaign.timezone || DEFAULT_TZ).trim() || DEFAULT_TZ;
  const days = Array.isArray(campaign.schedule_days) && campaign.schedule_days.length
    ? new Set(campaign.schedule_days.map((d) => Number(d)))
    : new Set([1, 2, 3, 4, 5]);
  const { h: sH, min: sM } = parseHm(campaign.schedule_start);
  const { h: eH, min: eM } = parseHm(campaign.schedule_end);
  let dt = DateTime.fromJSDate(from, { zone: tz });
  for (let i = 0; i < 21; i += 1) {
    const weekday = dt.weekday;
    if (!days.has(weekday)) {
      dt = dt.plus({ days: 1 }).startOf('day').set({ hour: sH, minute: sM, second: 0, millisecond: 0 });
      continue;
    }
    const dayStart = dt.startOf('day');
    const winStart = dayStart.set({ hour: sH, minute: sM, second: 0, millisecond: 0 });
    const winEnd = dayStart.set({ hour: eH, minute: eM, second: 0, millisecond: 0 });
    if (winEnd <= winStart) {
      return dt.toUTC().toJSDate();
    }
    if (dt < winStart) return winStart.toUTC().toJSDate();
    if (dt < winEnd) return dt.toUTC().toJSDate();
    dt = dt.plus({ days: 1 }).startOf('day').set({ hour: sH, minute: sM, second: 0, millisecond: 0 });
  }
  return from;
}

/**
 * Apply delay_ms then snap to next allowed window start (SmartLead-style wait-then-send-in-window).
 */
function scheduleAfterDelay(campaign, fromDate, delayMs) {
  const base = new Date(fromDate.getTime() + Math.max(0, Number(delayMs) || 0));
  return nextAllowedSendAt(campaign, base);
}

/**
 * Respect min gap after last send (campaign-wide).
 */
function applyMinGap(campaign, candidateDate, lastSendAt) {
  const gap = Math.max(0, Number(campaign.min_gap_between_sends_ms) || 0);
  if (!gap || !lastSendAt) return candidateDate;
  const minNext = new Date(lastSendAt.getTime() + gap);
  if (candidateDate >= minNext) return candidateDate;
  return nextAllowedSendAt(campaign, minNext);
}

module.exports = {
  nextAllowedSendAt,
  scheduleAfterDelay,
  applyMinGap,
  DEFAULT_TZ,
};
