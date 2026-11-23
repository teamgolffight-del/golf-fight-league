import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import league from "../dist/league-data.js";

const cookieName = "__Host-gfl-session";
const sessionSeconds = 14 * 86400;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const mac = (key, data) => createHmac("sha256", key).update(data).digest("hex");
const memberIds = new Set(league.initialState().players.map(({ id }) => id));

function equal(a, b) {
  return typeof b === "string" && /^[a-f0-9]{64}$/.test(b) && a.length === b.length &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b, "ascii"));
}

function response(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function configFrom(env) {
  const mode = env.GFL_SHEETS_MODE;
  if ((mode !== "test" || env.VERCEL_ENV === "production") &&
      (mode !== "production" || env.VERCEL_ENV !== "production" || env.GFL_SHEETS_ENABLED !== "1")) return null;
  if ((env.GFL_SHEETS_SECRET || "").length < 32 || (env.GFL_SESSION_SECRET || "").length < 32) return null;
  try {
    const url = new URL(env.GFL_SHEETS_URL);
    if (url.origin !== "https://script.google.com" || url.username || url.password || url.search || url.hash ||
        !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)) return null;
    const codes = JSON.parse(env.GFL_PLAYER_CODES);
    if ([...memberIds].some((id) => typeof codes[id] !== "string" || !/^[a-f0-9]{64}$/.test(codes[id]))) return null;
    return { mode, url, codes, sessionSecret: env.GFL_SESSION_SECRET, sheetsSecret: env.GFL_SHEETS_SECRET };
  } catch { return null; }
}

function sessionHeader(config, id) {
  const expiry = Math.floor(Date.now() / 1000) + sessionSeconds;
  const value = id + "." + expiry;
  const signature = mac(config.sessionSecret, value + ":" + config.codes[id]);
  return cookieName + "=" + value + "." + signature + "; Path=/; Max-Age=" + sessionSeconds + "; Secure; HttpOnly; SameSite=Strict";
}

function sessionActor(request, config) {
  const value = request.headers.get("cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
  const [id, expiry, signature, extra] = value?.split(".") || [];
  if (extra !== undefined || !memberIds.has(id) || !/^\d+$/.test(expiry) || Number(expiry) <= Date.now() / 1000) return null;
  return equal(mac(config.sessionSecret, id + "." + expiry + ":" + config.codes[id]), signature) ? id : null;
}

async function readData(request) {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") throw new Error("La requête doit être en JSON.");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("La saisie est vide.");
  let bytes = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > 8192) { await reader.cancel(); throw new Error("La saisie est trop volumineuse."); }
    chunks.push(value);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("La saisie doit être un objet.");
  return data;
}

async function sendToSheets(config, action, actor, data, id, fetcher) {
  const payload = JSON.stringify({ version: 1, mode: config.mode, time: Date.now(), nonce: randomBytes(16).toString("hex"), action, actor, data, id });
  const options = { redirect: "manual", signal: AbortSignal.timeout(15000) };
  let result = await fetcher(config.url, {
    ...options, method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload, signature: mac(config.sheetsSecret, payload) }),
  });
  if ([302, 303].includes(result.status)) {
    const redirected = new URL(result.headers.get("location"), config.url);
    if (redirected.origin !== "https://script.googleusercontent.com" || redirected.username || redirected.password) {
      throw new Error("Unexpected Apps Script redirect");
    }
    result = await fetcher(redirected, { ...options, method: "GET" });
  }
  if (!result.ok) throw new Error("Apps Script HTTP " + result.status);
  const body = await result.json();
  if (body.ok === true) return response({ ...body.data, viewerId: actor });
  const status = [400, 403, 404, 409, 502, 503].includes(body.status) ? body.status : 502;
  return response({ error: body.error || "Synchronisation indisponible.", code: body.code }, status);
}

export async function handleLeagueRequest(request, env = process.env, fetcher = fetch) {
  const config = configFrom(env);
  if (!config) return response({ error: "La ligue partagée n’est pas activée." }, 503);
  const url = new URL(request.url);
  const path = url.searchParams.get("route") || "/api/league";
  const method = request.method;
  const writing = method === "POST" || method === "PATCH";
  if (writing && request.headers.get("origin") !== url.origin) return response({ error: "Origine non autorisée." }, 403);

  let actor = sessionActor(request, config);
  const login = method === "POST" && path === "/api/session";
  if (!actor && !login) return response({ error: "Connecte-toi à la League." }, 401);
  let data;
  if (writing) {
    try { data = await readData(request); }
    catch { return response({ error: "Saisie JSON invalide ou trop volumineuse." }, 400); }
  }
  if (login) {
    const { player, code } = data;
    if (!memberIds.has(player) || typeof code !== "string" || code.length > 128 ||
        !equal(config.codes[player], digest(code.trim()))) return response({ error: "Profil ou code incorrect." }, 401);
    actor = player;
    const result = await syncSafely(config, "snapshot", actor, undefined, undefined, fetcher);
    if (!result.ok) return result;
    return response(await result.json(), 200, { "Set-Cookie": sessionHeader(config, actor) });
  }

  const correction = method === "PATCH" && /^\/api\/games\/([a-z0-9-]{1,80})$/.exec(path);
  let action;
  if (method === "GET" && path === "/api/league") action = "snapshot";
  else if (method === "GET" && path === "/api/export") action = "export";
  else if (method === "POST" && path === "/api/games") action = "create";
  else if (method === "PATCH" && path === "/api/profile") action = "profile";
  else if (correction) action = "correct";
  else return response({ error: "Action inconnue." }, 404);
  if (["correct", "export"].includes(action) && actor !== "x-factor") {
    return response({ error: "Action réservée à l’administrateur de la League." }, 403);
  }
  return syncSafely(config, action, actor, data, correction?.[1], fetcher);
}

async function syncSafely(config, action, actor, data, id, fetcher) {
  try { return await sendToSheets(config, action, actor, data, id, fetcher); }
  catch (error) {
    console.error("League sync:", action, error.name);
    return response({ error: "Google Sheets est momentanément indisponible. Réessaie." }, 502);
  }
}

export default {
  fetch(request) { return handleLeagueRequest(request); },
};
