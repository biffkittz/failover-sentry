import {
  ActivityFailure,
  ApplicationFailure,
  CancelledFailure,
  ChildWorkflowFailure,
  TimeoutFailure,
} from '@temporalio/workflow';

/** A short human-readable description of a failure, for step details, alerts and the timeline. */
export function describeFailure(error: unknown): string {
  if (error instanceof ActivityFailure) {
    return describeFailure(error.cause ?? error);
  }
  if (error instanceof ChildWorkflowFailure) {
    return `child workflow failed: ${describeFailure(error.cause ?? error)}`;
  }
  if (error instanceof TimeoutFailure) {
    return `timed out (${String(error.timeoutType)})`;
  }
  if (error instanceof CancelledFailure) {
    return 'cancelled';
  }
  if (error instanceof ApplicationFailure) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** The application error type of a failure (e.g. `ReplicationStalled`), if any. */
export function failureType(error: unknown): string | null {
  if (error instanceof ActivityFailure || error instanceof ChildWorkflowFailure) {
    return failureType(error.cause);
  }
  if (error instanceof ApplicationFailure) {
    return error.type ?? null;
  }
  return null;
}
