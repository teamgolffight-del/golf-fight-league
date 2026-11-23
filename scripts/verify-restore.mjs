import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import league from "../dist/league-data.js";

export function verifyRestore(before, restored) {
  if (before.schemaVersion !== 1 || restored.schemaVersion !== 1) throw new Error("Version de sauvegarde incompatible.");
  const ordered = (rows, key) => [...rows].sort((a, b) => key(a).localeCompare(key(b)));
  const participants = (rows) => ordered(rows, (row) => row.playerId);
  const normalize = (backup) => ({
    players: ordered(backup.players, (player) => player.id),
    games: ordered(backup.games, (game) => game.id).map((game) => ({ ...game, participants: participants(game.participants) })),
    corrections: ordered(backup.corrections, (entry) => entry.gameId + ":" + entry.revision)
      .map((entry) => ({ ...entry, before: participants(entry.before), after: participants(entry.after) })),
  });
  const expected = normalize(before);
  const actual = normalize(restored);
  assert.deepEqual(actual, expected);
  assert.deepEqual(league.rank(actual.players, actual.games), league.rank(expected.players, expected.games));
  return { joueurs: actual.players.length, parties: actual.games.length, corrections: actual.corrections.length };
}

if (import.meta.main) {
  const [, , before, restored] = process.argv;
  if (!before || !restored) {
    console.error("Usage : node scripts/verify-restore.mjs export-avant.json export-restaure.json");
    process.exitCode = 1;
  } else {
    try {
      const backups = await Promise.all([before, restored].map(async (file) => JSON.parse(await readFile(file, "utf8"))));
      process.stdout.write(JSON.stringify(verifyRestore(...backups)) + "\n");
    } catch {
      console.error("Vérification impossible : export invalide ou écarts après restauration.");
      process.exitCode = 1;
    }
  }
}
