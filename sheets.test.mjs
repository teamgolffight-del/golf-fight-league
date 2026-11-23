import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import league from "./dist/league-data.js";
import { handleLeagueRequest } from "./api/league.mjs";
import { verifyRestore } from "./scripts/verify-restore.mjs";

const headers = {
  Joueurs: "joueur_id alias type actif devise date_creation notes",
  Formats: "format_id libelle actif participants_min participants_max remarque",
  Parties: "partie_id date_partie format_id saison statut saisie_par cree_le modifie_le revision commentaire",
  Participations: "participation_id partie_id joueur_id equipe_id gagnant points commentaire",
  Corrections: "correction_id partie_id date_correction acteur_id champ_modifie avant_json apres_json raison revision_avant revision_apres",
  Saisons: "saison_id libelle debut fin actif",
};
const fixture = league.initialState().players;
const codeFor = (id) => "code-de-test-non-reutilisable-" + id;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const env = {
  VERCEL_ENV: "preview", GFL_SHEETS_MODE: "test",
  GFL_SHEETS_URL: "https://script.google.com/macros/s/gflFixture/exec",
  GFL_SHEETS_SECRET: "secret-synchronisation-reserve-aux-tests",
  GFL_SESSION_SECRET: "secret-session-reserve-aux-tests",
  GFL_PLAYER_CODES: JSON.stringify(Object.fromEntries(fixture.map(({ id }) => [id, hash(codeFor(id))]))),
};

function createFixture(backup) {
  let tables = Object.fromEntries(Object.entries(headers).map(([name, row]) => [name, [row.split(" ")]]));
  const ids = Object.keys(tables);
  tables.Joueurs.push(...fixture.map(({ id, alias }) => [id, alias, "Permanent", true]));
  tables.Joueurs.push(["guest", "Invité", "Wild Card", true]);
  tables.Formats.push(...league.formats.filter((label) => label !== "Foursome")
    .map((label) => [league.formatId(label), label, true, 2, 8, ""]));
  tables.Saisons.push(["2026", "Saison 2026", "2026-01-01", "2026-12-31", true]);
  if (backup) tables = structuredClone(backup);
  const nonceCache = new Map();
  const posts = [];
  const requests = [];
  const config = { GFL_MODE: "test", GFL_SPREADSHEET_ID: "fixture", GFL_REAL_SPREADSHEET_ID: "real",
    GFL_SHEETS_SECRET: env.GFL_SHEETS_SECRET };
  const book = { getId: () => "fixture", getSheetByName: (name) => ({
    getSheetId: () => ids.indexOf(name), getMaxRows: () => 1000,
  }) };
  let held = false;
  let busy = false;
  let failWrite = false;
  let dropResponse = false;
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => config }) },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (value) => ({ setMimeType: () => value }) },
    Utilities: { Charset: { UTF_8: "UTF_8" },
      computeHmacSha256Signature: (payload, key) => Array.from(createHmac("sha256", key).update(payload).digest()) },
    LockService: { getScriptLock: () => {
      let owned = false;
      const acquire = () => {
        if (held || busy) return false;
        held = true;
        owned = true;
        return true;
      };
      return { tryLock: acquire, waitLock: () => assert(acquire()), hasLock: () => owned, releaseLock: () => { held = false; owned = false; } };
    } },
    CacheService: { getScriptCache: () => ({ get: (key) => nonceCache.get(key), put: (key, value) => nonceCache.set(key, value) }) },
    SpreadsheetApp: { openById: (id) => { assert.equal(id, "fixture"); assert(held); return book; } },
    Sheets: { Spreadsheets: {
      Values: { batchGet: (id, { ranges }) => {
        assert.equal(id, "fixture");
        return { valueRanges: ranges.map((range) => ({ values: structuredClone(tables[range.split("'")[1]]) })) };
      } },
      batchUpdate: (batch, id) => {
        assert.equal(id, "fixture");
        assert(held);
        if (failWrite) throw new Error("écriture refusée par Google");
        requests.push(batch.requests.length);
        const next = structuredClone(tables);
        for (const { updateCells } of batch.requests) {
          const { sheetId, rowIndex, columnIndex } = updateCells.start;
          const rows = next[ids[sheetId]];
          for (const [offset, row] of updateCells.rows.entries()) {
            const cells = rows[rowIndex + offset] ||= [];
            row.values.forEach(({ userEnteredValue }, i) => { cells[columnIndex + i] = Object.values(userEnteredValue)[0]; });
          }
        }
        tables = next;
      },
    } },
  });
  for (const file of ["dist/league-data.js", "apps-script/Code.js"]) vm.runInContext(readFileSync(file, "utf8"), context);
  const callScript = (body) => JSON.parse(context.doPost({ postData: { contents: body } }));
  const redirect = new Map();
  async function fetcher(url, options) {
    if (options.method === "GET") {
      assert.equal(url.origin, "https://script.googleusercontent.com");
      assert.equal(options.body, undefined);
      if (dropResponse) throw new TypeError("Connexion interrompue après l’écriture");
      return Response.json(redirect.get(url.pathname));
    }
    assert.equal(String(url), env.GFL_SHEETS_URL);
    assert.equal(options.redirect, "manual");
    posts.push(options.body);
    const path = "/" + posts.length;
    redirect.set(path, callScript(options.body));
    return new Response(null, { status: 302, headers: { Location: "https://script.googleusercontent.com" + path } });
  }
  return {
    fetcher, posts, requests, callScript, rows: (name) => tables[name],
    backup: () => structuredClone(tables),
    seedFoursome: () => context.ajouterFoursome(), config,
    setBusy: (value) => { busy = value; }, setFailedWrite: (value) => { failWrite = value; },
    setDropResponse: (value) => { dropResponse = value; },
  };
}

function client(fetcher) {
  let cookie = "";
  return {
    async send(path, method = "GET", data, origin = "https://league.test", extraHeaders = {}) {
      const headers = { origin, cookie, ...extraHeaders };
      if (data !== undefined) headers["content-type"] = "application/json";
      const response = await handleLeagueRequest(new Request("https://league.test/api/league?route=" + encodeURIComponent(path), {
        method, headers, body: data === undefined ? undefined : JSON.stringify(data),
      }), env, fetcher);
      if (response.headers.has("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
      return response;
    },
  };
}

function game(seed, formula, groups, winner) {
  return { id: seed.repeat(32), date: "2026-11-23", formula, groups, winner };
}

test("Règles Match Play, Foursome, troisième équipe et Wild Cards", () => {
  const one = [["kid", "captain"]];
  const pairs = [["kid", "captain"], ["foxy", "fyzio"]];
  const three = [...pairs, ["x-factor", "lady"]];
  assert.equal(league.recordGame(game("a", "Match Play", one, "kid")).participants[0].points, 1);
  for (const formula of ["Match Play", "Foursome"]) {
    assert.deepEqual(league.recordGame(game("a", formula, pairs, "A")).participants.map((p) => p.points), [1, 1, 0, 0]);
    assert.throws(() => league.recordGame(game("a", formula, three, "C")));
  }
  assert.throws(() => league.recordGame(game("a", "Foursome", one, "kid")));
  assert.deepEqual(league.recordGame(game("a", "Scramble", three, "C")).participants.map((p) => p.points), [0, 0, 0, 0, 1, 1]);
  for (const teamCount of [2, 3]) {
    const assignments = new Map();
    const checked = ["kid", "captain", "lady", "fyzio", "x-factor", "foxy"].slice(0, teamCount * 2);
    const teams = league.teamCodes.slice(0, teamCount);
    for (const index of checked.keys()) league.assignTeams(checked.slice(0, index + 1).sort(), teams, assignments);
    assert.deepEqual(teams.map((team) => [...assignments.values()].filter((value) => value === team).length), Array(teamCount).fill(2));
  }
  for (const formula of ["Scramble", "Shamble", "Chouette", "Skins", "Wolf"]) {
    assert.deepEqual(league.recordGame(game("a", formula, pairs, "B")).participants.map((p) => p.points), [0, 0, 1, 1]);
    assert.deepEqual(league.recordGame(game("a", formula, one, "captain")).participants.map((p) => p.points), [0, 1]);
    assert.throws(() => league.recordGame(game("a", formula, pairs, "")));
  }
  const roster = [...fixture, { id: "guest", alias: "Invité", permanent: false }];
  const invited = league.recordGame(game("a", "Match Play", [["kid", "guest"]], "guest"), roster);
  assert.deepEqual(invited.participants.map((p) => p.points), [0, 0]);
  assert.equal(invited.participants[1].won, true);
  assert.equal(league.rank(roster, [invited]).length, 8);
});

test("Deux sessions partagent les écritures, les doublons et les corrections avec le référentiel", async () => {
  const store = createFixture();
  store.seedFoursome();
  store.seedFoursome();
  assert.equal(store.rows("Formats").filter((row) => row[0] === "foursome").length, 1);

  const kid = client(store.fetcher);
  const admin = client(store.fetcher);
  const anonymous = client(store.fetcher);
  assert.equal((await anonymous.send("/api/league")).status, 401);
  assert.equal((await anonymous.send("/api/games", "POST", {}, "https://league.test", { "X-League-Demo-Player": "x-factor" })).status, 401);
  assert.equal((await kid.send("/api/session", "POST", { player: "kid", code: "incorrect" })).status, 401);
  for (const [player, device] of [["kid", kid], ["x-factor", admin]]) {
    const signin = await device.send("/api/session", "POST", { player, code: codeFor(player) });
    assert.equal(signin.status, 200);
    assert.match(signin.headers.get("set-cookie"), /Secure; HttpOnly; SameSite=Strict/);
  }
  assert.equal(store.callScript(store.posts[0]).status, 409);
  const tampered = JSON.parse(store.posts[0]);
  tampered.payload = tampered.payload.replace('"kid"', '"x-factor"');
  assert.equal(store.callScript(JSON.stringify(tampered)).status, 403);
  assert.equal((await kid.send("/api/games", "POST", {}, "https://other.test")).status, 403);

  const one = game("a", "Match Play", [["kid", "captain"]], "kid");
  const pairs = [["kid", "captain"], ["foxy", "fyzio"]];
  const foursome = game("b", "Foursome", pairs, "B");
  const doubles = game("c", "Match Play", pairs, "B");
  const three = game("d", "Scramble", [...pairs, ["lady", "nitro"]], "C");
  const first = await Promise.all([
    kid.send("/api/games", "POST", one),
    admin.send("/api/games", "POST", foursome),
    kid.send("/api/games", "POST", one),
  ]);
  assert.deepEqual(first.map((r) => r.status), [200, 200, 200]);
  assert.equal(store.rows("Parties").length, 3);
  assert.equal(store.rows("Participations").length, 7);
  assert.equal((await kid.send("/api/games", "POST", { ...one, id: "e".repeat(32) })).status, 409);
  assert.deepEqual((await Promise.all([
    kid.send("/api/games", "POST", doubles), admin.send("/api/games", "POST", three),
    admin.send("/api/games", "POST", { ...doubles, id: "f".repeat(32) }),
  ])).map((r) => r.status).sort(), [200, 200, 409]);
  assert.equal(store.rows("Parties")[1][3], "2026");
  assert.equal(store.rows("Participations").filter((r) => r[3] === "C" && r[5] === 1).length, 2);
  const fromAdmin = await (await admin.send("/api/league")).json();
  assert.equal(fromAdmin.games.length, 4);
  assert.equal(league.summarize(fromAdmin.games, "kid").wins, 1);
  const patch = { revision: 1, winner: "captain", reason: "Résultat inversé" };
  assert.equal((await kid.send("/api/games/" + one.id, "PATCH", patch)).status, 403);
  assert.deepEqual((await Promise.all([
    admin.send("/api/games/" + one.id, "PATCH", patch), admin.send("/api/games/" + one.id, "PATCH", patch),
  ])).map((r) => r.status).sort(), [200, 409]);
  assert.equal((await kid.send("/api/games", "POST", one)).status, 200);
  const shared = await (await kid.send("/api/league")).json();
  assert.equal(shared.corrections.length, 1);
  assert.equal(shared.corrections[0].before.find((r) => r.won).playerId, "kid");
  assert.equal(shared.corrections[0].after.find((r) => r.won).playerId, "captain");
  assert.equal(league.summarize(shared.games, "kid").wins, 0);
  const lastAdmin = await (await admin.send("/api/league")).json();
  assert.deepEqual(lastAdmin.games, shared.games);
  assert.deepEqual(league.rank(lastAdmin.players, lastAdmin.games), league.rank(shared.players, shared.games));
  assert.equal((await kid.send("/api/export")).status, 403);
  assert.equal((await (await admin.send("/api/export")).json()).schemaVersion, 1);
  assert.equal((await kid.send("/api/profile", "PATCH", { alias: "Kid", motto: "=2+2", bio: "Test" })).status, 200);
  assert.equal(store.rows("Joueurs").find((row) => row[0] === "kid")[4], "=2+2");

  store.setBusy(true);
  assert.equal((await admin.send("/api/league")).status, 503);
  store.setBusy(false);
  store.setFailedWrite(true);
  const prior = store.rows("Parties").length;
  const retryable = game("e", "Wolf", [["kid", "foxy"]], "kid");
  assert.equal((await admin.send("/api/games", "POST", retryable)).status, 502);
  assert.equal(store.rows("Parties").length, prior);
  store.setFailedWrite(false);
  store.setDropResponse(true);
  assert.equal((await admin.send("/api/games", "POST", retryable)).status, 502);
  assert.equal(store.rows("Parties").length, prior + 1);
  store.setDropResponse(false);
  assert.equal((await admin.send("/api/games", "POST", retryable)).status, 200);
  assert.equal(store.rows("Parties").length, prior + 1);

  const exported = await (await admin.send("/api/export")).json();
  const restored = client(createFixture(store.backup()).fetcher);
  assert.equal((await restored.send("/api/session", "POST", { player: "x-factor", code: codeFor("x-factor") })).status, 200);
  const restoredExport = await (await restored.send("/api/export")).json();
  assert.deepEqual(verifyRestore(exported, restoredExport), { joueurs: 9, parties: 5, corrections: 1 });
  restoredExport.corrections[0].reason = "Audit incomplet";
  assert.throws(() => verifyRestore(exported, restoredExport));
  store.config.GFL_SPREADSHEET_ID = "real";
  assert.equal((await admin.send("/api/league")).status, 503);

  const disabled = await handleLeagueRequest(new Request("https://league.test/api/league"), { ...env, VERCEL_ENV: "production" }, store.fetcher);
  assert.equal(disabled.status, 503);
});
