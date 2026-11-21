/**
 * Formats a non-negative number of seconds as a review timecode.
 *
 * `3.2` becomes `00:03.200`; times of an hour or more gain an hours field.
 * The fractional part is always exactly milliseconds so REVIEW.md snapshots
 * stay stable across machines.
 */
export function formatTimecode(seconds: number): string {
    const totalMilliseconds = Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 1000);
    const milliseconds = totalMilliseconds % 1000;
    const totalSeconds = Math.floor(totalMilliseconds / 1000);
    const displaySeconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const displayMinutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);
    const clock = hours > 0
        ? `${String(hours).padStart(2, "0")}:${String(displayMinutes).padStart(2, "0")}:${String(displaySeconds).padStart(2, "0")}`
        : `${String(displayMinutes).padStart(2, "0")}:${String(displaySeconds).padStart(2, "0")}`;
    return `${clock}.${String(milliseconds).padStart(3, "0")}`;
}
