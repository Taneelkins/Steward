/**
 * Roblox Open Cloud API v2 — in-game player management.
 *
 * Docs: https://create.roblox.com/docs/cloud/reference/UserRestrictions
 *
 * Required API key permissions (set in the Roblox Creator Hub):
 *   Experience > Manage Users  (sometimes listed as "Manage Game Join Restriction")
 *   Scope must include the specific Universe you want to manage.
 *
 * How to get your Universe ID:
 *   Open your game in the Creator Hub (create.roblox.com), look at the URL:
 *   https://create.roblox.com/dashboard/creations/experiences/{universeId}/overview
 */
const ROBLOX_USERS_API = "https://users.roblox.com";
const ROBLOX_CLOUD_API = "https://apis.roblox.com/cloud/v2";
// ── User Lookup ───────────────────────────────────────────────────────────────
/**
 * Resolve a Roblox username to its numeric user ID.
 * Returns null if the username does not exist or the API is unreachable.
 */
export async function lookupRobloxUser(username) {
    try {
        const res = await fetch(`${ROBLOX_USERS_API}/v1/usernames/users`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ usernames: [username.trim()], excludeBannedUsers: false }),
            signal: AbortSignal.timeout(10_000)
        });
        if (!res.ok)
            return null;
        const data = (await res.json());
        return data.data[0] ?? null;
    }
    catch {
        return null;
    }
}
// ── Ban / Unban ───────────────────────────────────────────────────────────────
/**
 * Ban a player from a Roblox experience.
 *
 * @param durationSeconds  Seconds for a temporary ban. Omit (undefined) for a permanent ban.
 * @param excludeAltAccounts  When true, Roblox also restricts known alt accounts.
 */
export async function banRobloxPlayer(options) {
    const { universeId, apiKey, robloxUserId, displayReason, privateReason, durationSeconds, excludeAltAccounts = false } = options;
    const restriction = {
        active: true,
        displayReason: displayReason.slice(0, 400),
        privateReason: privateReason.slice(0, 400),
        excludeAltAccounts
    };
    if (durationSeconds !== undefined) {
        restriction.duration = `${durationSeconds}s`;
    }
    return callUserRestriction(universeId, apiKey, robloxUserId, { gameJoinRestriction: restriction });
}
/** Remove an active ban for a player in a Roblox experience. */
export async function unbanRobloxPlayer(options) {
    return callUserRestriction(options.universeId, options.apiKey, options.robloxUserId, {
        gameJoinRestriction: { active: false }
    });
}
async function callUserRestriction(universeId, apiKey, robloxUserId, body) {
    try {
        // Open Cloud v2: resource path is /user-restrictions/{userId} — no "users/" segment
        const url = `${ROBLOX_CLOUD_API}/universes/${universeId}/user-restrictions/${robloxUserId}?updateMask=gameJoinRestriction`;
        const res = await fetch(url, {
            method: "PATCH",
            headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15_000)
        });
        if (!res.ok) {
            let detail = "";
            try {
                const errBody = (await res.json());
                detail = errBody.message ?? errBody.code ?? "";
            }
            catch {
                detail = await res.text().catch(() => "");
            }
            return {
                success: false,
                error: `Roblox API ${res.status}${detail ? `: ${detail.slice(0, 250)}` : ""}`
            };
        }
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Network error" };
    }
}
// ── Real-time kick via MessagingService ──────────────────────────────────────
/**
 * Sends a kick request to every running game server so a player who is
 * currently online gets booted immediately after being banned.
 *
 * This is best-effort — it will silently succeed even if no game server is
 * running or the API key lacks messaging-service write permissions.
 *
 * The game server must have the BanHandler.server.luau script installed and
 * subscribed to the "ModerationKick" topic.
 */
export async function kickActivePlayer(universeId, apiKey, robloxUserId, reason) {
    const url = `https://apis.roblox.com/messaging-service/v1/universes/${universeId}/topics/ModerationKick`;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({
                message: JSON.stringify({ userId: robloxUserId, reason: reason.slice(0, 200) })
            }),
            signal: AbortSignal.timeout(10_000)
        });
        if (!res.ok) {
            console.warn(`[roblox] MessagingService kick failed for userId ${robloxUserId}: HTTP ${res.status}`);
        }
    }
    catch (err) {
        console.warn(`[roblox] MessagingService kick request failed for userId ${robloxUserId}:`, err);
    }
}
// ── Duration Parsing ──────────────────────────────────────────────────────────
/**
 * Parse a human-readable duration string into seconds.
 * Returns `undefined` for permanent/perm/indefinite.
 * Returns `null` if the string cannot be parsed.
 */
export function parseRobloxDuration(value) {
    if (!value)
        return undefined; // no duration = permanent
    const lower = value.trim().toLowerCase();
    if (lower === "permanent" || lower === "perm" || lower === "indefinite" || lower === "forever") {
        return undefined;
    }
    const patterns = [
        [/(\d+)\s*(?:years?|yrs?)\b/i, 365 * 24 * 3600],
        [/(\d+)\s*months?\b/i, 30 * 24 * 3600],
        [/(\d+)\s*(?:weeks?|wks?)\b/i, 7 * 24 * 3600],
        [/(\d+)\s*days?\b/i, 24 * 3600],
        [/(\d+)\s*hours?\b/i, 3600],
        [/(\d+)\s*(?:minutes?|mins?)\b/i, 60],
        [/(\d+)\s*d(?!\w)/i, 24 * 3600],
        [/(\d+)\s*h(?!\w)/i, 3600],
        [/(\d+)\s*m(?!\w)/i, 60],
    ];
    // Track consumed positions so "7d" doesn't double-match
    const consumed = new Set();
    let total = 0;
    let matched = false;
    for (const [re, mult] of patterns) {
        re.lastIndex = 0;
        let m;
        const reGlobal = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
        while ((m = reGlobal.exec(value)) !== null) {
            if (!consumed.has(m.index)) {
                for (let i = m.index; i < m.index + m[0].length; i++)
                    consumed.add(i);
                total += parseInt(m[1], 10) * mult;
                matched = true;
            }
        }
    }
    return matched ? total : null;
}
/** Format seconds into a human-readable duration string. */
export function formatRobloxDuration(seconds) {
    if (seconds === undefined)
        return "Permanent";
    if (seconds < 60)
        return `${seconds}s`;
    if (seconds < 3600)
        return `${Math.round(seconds / 60)}m`;
    if (seconds < 86400)
        return `${Math.round(seconds / 3600)}h`;
    if (seconds < 86400 * 7)
        return `${Math.round(seconds / 86400)}d`;
    if (seconds < 86400 * 30)
        return `${Math.round(seconds / (86400 * 7))}w`;
    if (seconds < 86400 * 365)
        return `${Math.round(seconds / (86400 * 30))}mo`;
    return `${Math.round(seconds / (86400 * 365))}y`;
}
