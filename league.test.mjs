import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import league from "./dist/league-data.js";
import { createLeagueServer } from "./server.mjs";

async function withServer(filename, action) {
  const server = createLeagueServer(filename);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    await action(async (path, { method = "GET", actor, body } = {}) => {
      const headers = {};
      if (actor) headers["X-League-Demo-Player"] = actor;
      if (body) headers["Content-Type"] = "application/json";
      return fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("La League enregistre, corrige et retrouve les résultats après redémarrage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "golf-fight-league-"));
  const filename = join(directory, "test.sqlite");
  const individual = {
    id: "a".repeat(32), date: "2026-11-20", formula: "Wolf",
    groups: [["captain", "kid", "fyzio", "x-factor"]], winner: "kid",
  };
  try {
    await withServer(filename, async (request) => {
      assert.match(await (await request("/")).text(), /GOLF FIGHT/);
      assert.equal((await request("/league.js")).status, 200);
      const initial = await (await request("/api/league")).json();
      assert.equal(initial.players.length, 8);
      assert.equal(initial.games.length, 4);

      const save = (body, actor = "kid") => request("/api/games", { method: "POST", actor, body });
      const [first, retry] = await Promise.all([save(individual), save(individual)]);
      for (const response of [first, retry]) {
        assert.equal(response.status, 200);
        const { games } = await response.json();
        assert.equal(games.length, 5);
        assert.equal(games.find((game) => game.id === individual.id).authorId, "kid");
      }

      const rematch = { ...individual, id: "b".repeat(32), groups: [[...individual.groups[0]].reverse()] };
      const duplicate = await save(rematch, "captain");
      assert.equal(duplicate.status, 409);
      assert.equal((await duplicate.json()).code, "possible_duplicate");
      assert.equal((await save({ ...rematch, confirmDistinct: true }, "captain")).status, 200);

      const team = {
        id: "c".repeat(32), date: "2026-11-21", formula: "Scramble",
        groups: [["captain", "fyzio"], ["nitro", "sniper"]], winner: "A",
      };
      const teamResult = await save(team);
      assert.equal(teamResult.status, 200);
      const state = await teamResult.json();
      assert.deepEqual(state.games[0].participants.map((player) => player.points), [1, 1, 0, 0]);
      assert.deepEqual(league.summarize(state.games, "lady"), league.summarize(initial.games, "lady"));
      assert.equal((await save({ ...team, id: "d".repeat(32), date: "2026-02-30" })).status, 400);

      const correct = (actor, winner) => request("/api/games/" + team.id, {
        method: "PATCH", actor, body: { revision: 1, winner, reason: "Erreur de saisie" },
      });
      assert.equal((await correct("kid", "B")).status, 403);
      const results = await Promise.all([correct("x-factor", "B"), correct("x-factor", "B")]);
      assert.deepEqual(results.map((response) => response.status).sort(), [200, 409]);
      assert.equal((await request("/api/export", { actor: "kid" })).status, 403);
      assert.equal((await request("/api/profile", {
        method: "PATCH", actor: "kid", body: { alias: "CAPTAIN", motto: "", bio: "" },
      })).status, 409);
      assert.equal((await request("/api/profile", {
        method: "PATCH", actor: "kid", body: { alias: "Kid Démo", motto: "", bio: "" },
      })).status, 200);
    });

    await withServer(filename, async (request) => {
      const exportResponse = await request("/api/export", { actor: "x-factor" });
      assert.equal(exportResponse.status, 200);
      const restored = await exportResponse.json();
      assert.equal(restored.schemaVersion, 1);
      assert.equal(restored.games.length, 7);
      assert.deepEqual(restored.games[0].participants.map((entry) => entry.points), [0, 0, 1, 1]);
      assert.equal(restored.corrections.length, 1);
      assert.equal(restored.corrections[0].actorId, "x-factor");
      assert.equal(restored.corrections[0].reason, "Erreur de saisie");
      assert.deepEqual(restored.corrections[0].before.map((entry) => entry.points), [1, 1, 0, 0]);
      assert.equal(restored.players.find((player) => player.id === "kid").alias, "Kid Démo");
      assert.equal(league.rank(restored.players, restored.games).find((player) => player.id === "kid").wins, 2);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
