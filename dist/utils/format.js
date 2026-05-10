export function pointsToMilli(points) {
    return Math.round(points * 1000);
}
export function milliToPoints(milli) {
    return milli / 1000;
}
export function formatPoints(milli) {
    const points = milliToPoints(milli);
    return new Intl.NumberFormat("en-US", {
        maximumFractionDigits: 3,
        minimumFractionDigits: Number.isInteger(points) ? 0 : 1
    }).format(points);
}
export function formatMultiplier(milli) {
    return `${formatPoints(milli)}x`;
}
export function truncate(value, max = 1000) {
    if (!value)
        return "None";
    if (value.length <= max)
        return value;
    return `${value.slice(0, max - 3)}...`;
}
export function listOrNone(values) {
    return values.length > 0 ? values.join("\n") : "None";
}
export function boolLabel(value) {
    return value ? "Yes" : "No";
}
