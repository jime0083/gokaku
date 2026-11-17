import { info } from 'firebase-functions/logger';

export type XOperation =
  | 'post_create'
  | 'profile_read'
  | 'token_exchange'
  | 'token_refresh';

export interface XUsageEvent {
  readonly event: 'x_api_usage';
  readonly operation: XOperation;
  readonly measurement: 'request' | 'validated_resource';
  readonly requestCount: 0 | 1;
  readonly validatedResourceCount: 0 | 1;
  readonly estimatedCostMicroUsd: number | null;
  readonly costEstimateBasis:
    | 'per_request'
    | 'per_validated_resource_before_dedup'
    | 'unestimated';
  readonly unestimatedReason:
    | 'validated_resource_not_counted'
    | 'unknown_unit_price'
    | null;
  readonly currency: 'USD';
  readonly pricingSource: 'https://docs.x.com/x-api/getting-started/pricing';
  readonly pricingCheckedOn: '2026-10-31';
  readonly estimateKind: 'reference_only';
}

/** Synchronous logging sink; receives only the fixed usage schema. */
export type XUsageLogger = (event: XUsageEvent) => void;

const POST_REQUEST_MICRO_USD = 15_000;
const PROFILE_RESOURCE_MICRO_USD = 10_000;
const PRICING = {
  currency: 'USD',
  pricingSource: 'https://docs.x.com/x-api/getting-started/pricing',
  pricingCheckedOn: '2026-10-31',
  estimateKind: 'reference_only',
} as const;

function emit(event: XUsageEvent, logger: XUsageLogger): void {
  try {
    logger(event);
  } catch {
    // Logging must not change request behavior or expose the logger error.
  }
}

function requestEvent(operation: XOperation): XUsageEvent | undefined {
  // Reconstruct the operation from literals so runtime misuse cannot log input.
  let safeOperation: XOperation;
  switch (operation) {
    case 'post_create': safeOperation = 'post_create'; break;
    case 'profile_read': safeOperation = 'profile_read'; break;
    case 'token_exchange': safeOperation = 'token_exchange'; break;
    case 'token_refresh': safeOperation = 'token_refresh'; break;
    default: return undefined;
  }
  const post = safeOperation === 'post_create';
  return {
    event: 'x_api_usage',
    operation: safeOperation,
    measurement: 'request',
    requestCount: 1,
    validatedResourceCount: 0,
    estimatedCostMicroUsd: post ? POST_REQUEST_MICRO_USD : null,
    costEstimateBasis: post ? 'per_request' : 'unestimated',
    unestimatedReason: post
      ? null
      : safeOperation === 'profile_read'
        ? 'validated_resource_not_counted'
        : 'unknown_unit_price',
    ...PRICING,
  };
}

/**
 * Invoke exactly one actual HTTP attempt supplied by the caller.
 * Returns the original promise without observing its settlement or contents;
 * synchronous throws also retain their original identity and behavior.
 * Counts an invocation, not success or confirmed billing. No retry is performed.
 */
export function runXRequest<T>(
  operation: XOperation,
  request: () => Promise<T>,
  logger: XUsageLogger = info,
): Promise<T> {
  try {
    return request();
  } finally {
    const event = requestEvent(operation);
    if (event !== undefined) emit(event, logger);
  }
}

/**
 * Call once after validating one profile resource returned by an HTTP request.
 * Does not accept profile data or count another request. The reference estimate
 * is before provider deduplication and does not assert actual billing.
 */
export function recordProfileResource(logger: XUsageLogger = info): void {
  emit({
    event: 'x_api_usage',
    operation: 'profile_read',
    measurement: 'validated_resource',
    requestCount: 0,
    validatedResourceCount: 1,
    estimatedCostMicroUsd: PROFILE_RESOURCE_MICRO_USD,
    costEstimateBasis: 'per_validated_resource_before_dedup',
    unestimatedReason: null,
    ...PRICING,
  }, logger);
}
