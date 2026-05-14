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
import { createHash } from "node:crypto";
const ROBLOX_USERS_API = "https://users.roblox.com";
const ROBLOX_CLOUD_API = "https://apis.roblox.com/cloud/v2";
const ROBLOX_DATASTORE_V1 = "https://apis.roblox.com/datastores/v1";
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
// ── Real-time data edit via MessagingService ─────────────────────────────────
/**
 * Sends a data-edit request to every running game server so a player who is
 * currently online gets their stat changed immediately.
 *
 * This is best-effort — silently succeeds if no server is running.
 * The game server must have ModerationService.server.luau installed and
 * subscribed to the "ModerationDataEdit" topic.
 *
 * @param statPath  Dot-notation path matching DataManager:Change() format, e.g. "Stats.Elo"
 * @param value     New value — will be JSON-encoded and decoded on the game side
 */
export async function sendDataEdit(universeId, apiKey, robloxUserId, statPath, value) {
    const url = `https://apis.roblox.com/messaging-service/v1/universes/${universeId}/topics/ModerationDataEdit`;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({
                message: JSON.stringify({ userId: robloxUserId, statPath, value })
            }),
            signal: AbortSignal.timeout(10_000)
        });
        if (!res.ok) {
            console.warn(`[roblox] MessagingService data edit failed for userId ${robloxUserId}: HTTP ${res.status}`);
        }
    }
    catch (err) {
        console.warn(`[roblox] MessagingService data edit request failed for userId ${robloxUserId}:`, err);
    }
}
/**
 * Read a ProfileStore entry directly from the DataStore via Open Cloud API.
 *
 * Returns the full stored envelope:
 *   { Data: {...}, MetaData: { ActiveSession: [...] | null, ... }, GlobalUpdates: [...] }
 *
 * The API key must have the "DataStore" permission with Read access.
 * datastoreName must match the ProfileStore name used in the game (default: "Verdict01").
 */
export async function readProfileStoreEntry(options) {
    const { universeId, apiKey, userId, datastoreName = "Verdict01" } = options;
    const params = new URLSearchParams({ datastoreName, entryKey: String(userId) });
    const url = `${ROBLOX_DATASTORE_V1}/universes/${universeId}/standard-datastores/datastore/entries/entry?${params}`;
    try {
        const res = await fetch(url, {
            headers: { "x-api-key": apiKey },
            signal: AbortSignal.timeout(15_000)
        });
        if (res.status === 404) {
            return { success: false, error: "No saved data found for this player (they may have never joined).", notFound: true };
        }
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            return { success: false, error: `DataStore read failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}` };
        }
        const data = await res.json();
        return { success: true, data };
    }
    catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Network error reading DataStore" };
    }
}
/**
 * Write a ProfileStore entry back to the DataStore via Open Cloud API.
 * Pass the full envelope object returned by readProfileStoreEntry — we only
 * modify the nested value, the rest of the envelope (MetaData, GlobalUpdates, etc.)
 * is preserved exactly so ProfileStore's session locking is not disturbed.
 *
 * The API key must have the "DataStore" permission with Write access.
 */
export async function writeProfileStoreEntry(options) {
    const { universeId, apiKey, userId, entry, datastoreName = "Verdict01" } = options;
    const params = new URLSearchParams({ datastoreName, entryKey: String(userId) });
    const url = `${ROBLOX_DATASTORE_V1}/universes/${universeId}/standard-datastores/datastore/entries/entry?${params}`;
    const body = JSON.stringify(entry);
    const contentMd5 = createHash("md5").update(body).digest("base64");
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "x-api-key": apiKey,
                "content-type": "application/json",
                "content-md5": contentMd5
            },
            body,
            signal: AbortSignal.timeout(15_000)
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            return { success: false, error: `DataStore write failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}` };
        }
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Network error writing DataStore" };
    }
}
/**
 * Navigate a dot-notation path into a plain object and set the leaf value.
 * Returns false only if an intermediate key doesn't exist (bad path).
 * Always sets the final key regardless of whether it pre-existed.
 */
export function setNestedValue(obj, path, value) {
    const parts = path.split(".");
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const next = current[parts[i]];
        if (typeof next !== "object" || next === null || Array.isArray(next))
            return false;
        current = next;
    }
    current[parts[parts.length - 1]] = value;
    return true;
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
