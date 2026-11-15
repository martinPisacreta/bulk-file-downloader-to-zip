export const RUN_EVENT = 'run-started';
export const FILE_EVENT = 'file-downloaded';
export const MAX_BATCH_SIZE = 200;

function isPayPerEvent(actor) {
  const info = actor.getChargingManager?.()?.getPricingInfo?.();
  return info ? info.isPayPerEvent === true : typeof actor.charge === 'function';
}

/** Count unique URL downloads before calling this helper: duplicates share
 * one ZIP entry and therefore one file-downloaded event.
 */
export async function affordableFileCount(actor, remaining) {
  if (!Number.isSafeInteger(remaining) || remaining < 0) {
    throw new TypeError('Remaining file count must be a nonnegative safe integer');
  }
  if (remaining === 0 || !isPayPerEvent(actor)) return remaining;
  const manager = actor.getChargingManager?.();
  if (typeof manager?.calculateMaxEventChargeCountWithinLimit !== 'function') {
    throw new Error('Cannot determine the spending limit; no files will be downloaded');
  }
  const affordable = await manager.calculateMaxEventChargeCountWithinLimit(FILE_EVENT);
  if (affordable !== Infinity &&
      (!Number.isSafeInteger(affordable) || affordable < 0)) {
    throw new Error('Invalid affordable file count; no files will be downloaded');
  }
  return Math.min(remaining, affordable);
}

/** Never retry: a rejected response may follow a successful charge.
 * The caller must check processedCount and stop before downloading when
 * the run-started event was not charged or exhausted the spending limit.
 */
export async function chargeEvent(actor, eventName, count = 1) {
  if (![RUN_EVENT, FILE_EVENT].includes(eventName)) {
    throw new TypeError('Unsupported billing event');
  }
  if (!Number.isSafeInteger(count) || count < 0 ||
      (eventName === RUN_EVENT && count !== 1)) {
    throw new TypeError('Invalid billing event count');
  }
  if (count === 0 || !isPayPerEvent(actor)) {
    return { processedCount: count, chargedCount: 0, stop: false };
  }
  if (typeof actor.charge !== 'function') {
    throw new Error('Pay-per-event charging is unavailable');
  }
  const result = await actor.charge({ eventName, count });
  if (!result || !Number.isSafeInteger(result.chargedCount) ||
      result.chargedCount < 0 || result.chargedCount > count ||
      typeof result.eventChargeLimitReached !== 'boolean') {
    throw new Error('Invalid charging response; stop without retrying the charge');
  }
  return {
    processedCount: result.chargedCount,
    chargedCount: result.chargedCount,
    stop: result.chargedCount < count || result.eventChargeLimitReached,
  };
}
