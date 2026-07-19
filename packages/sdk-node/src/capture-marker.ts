const CAPTURE_TRUNCATED = Symbol("liveprobe.capture-truncated");

export interface CaptureTruncated {
  readonly [CAPTURE_TRUNCATED]: true;
}

export const CAPTURE_TRUNCATED_VALUE: CaptureTruncated = Object.freeze({
  [CAPTURE_TRUNCATED]: true as const,
});

export function isCaptureTruncated(value: unknown): value is CaptureTruncated {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<CaptureTruncated>)[CAPTURE_TRUNCATED] === true
  );
}
