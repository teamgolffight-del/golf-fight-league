import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import league from "./dist/league-data.js";

export class InputError extends Error {
  constructor(message, status = 400, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function parseGame(input) {
  try {
    return league.recordGame(input);
  } catch (error) {
    throw new InputError(error.message);
  }
}

function boundedText(value, max, label) {
  if (typeof value !== "string" || value.trim().length > max) {
    throw new InputError(label + " doit contenir au maximum " + max + " caractères.");
  }
  return value.trim();
}

export function openLeague(filename) {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      alias TEXT NOT NULL,
      alias_key TEXT NOT NULL UNIQUE,
      motto TEXT NOT NULL,
      bio TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      formula TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('single', 'team')),
      author_id TEXT NOT NULL REFERENCES players(id),
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'validated',
      ruleset_version INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 1,
      submission TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS participations (
      game_id TEXT NOT NULL REFERENCES games(id),
      player_id TEXT NOT NULL REFERENCES players(id),
      team TEXT CHECK(team IN ('A', 'B', 'C')),
      won INTEGER NOT NULL CHECK(won IN (0, 1)),
      points INTEGER NOT NULL CHECK(points >= 0),
      PRIMARY KEY (game_id, player_id)
    );
    CREATE TABLE IF NOT EXISTS corrections (
      game_id TEXT NOT NULL REFERENCES games(id),
      revision INTEGER NOT NULL,
      changed_at TEXT NOT NULL,
      actor_id TEXT NOT NULL REFERENCES players(id),
      reason TEXT NOT NULL,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      PRIMARY KEY (game_id, revision)
    );
  `);

  function transaction(action) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = action();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  transaction(() => {
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'participations'").get();
    if (!table.sql.includes("'B', 'C'")) {
      db.exec(`
        ALTER TABLE participations RENAME TO previous_participations;
        CREATE TABLE participations (
          game_id TEXT NOT NULL REFERENCES games(id),
          player_id TEXT NOT NULL REFERENCES players(id),
          team TEXT CHECK(team IN ('A', 'B', 'C')),
          won INTEGER NOT NULL CHECK(won IN (0, 1)),
          points INTEGER NOT NULL CHECK(points >= 0),
          PRIMARY KEY (game_id, player_id)
        );
        INSERT INTO participations SELECT * FROM previous_participations ORDER BY rowid;
        DROP TABLE previous_participations;
      `);
    }
  });

  const aliasKey = (alias) => alias.normalize("NFC").toLocaleLowerCase("fr");
  const actorExists = db.prepare("SELECT 1 FROM players WHERE id = ?");
  function checkActor(actor) {
    if (!actor || !actorExists.get(actor)) throw new InputError("Choisis un profil de démonstration.", 403);
  }

  function checkAdmin(actor) {
    checkActor(actor);
    if (actor !== "x-factor") throw new InputError("Cette action est réservée à X Factor dans la démonstration.", 403);
  }

  const insertPlayer = db.prepare("INSERT INTO players (id, alias, alias_key, motto, bio) VALUES (?, ?, ?, ?, ?)");
  const insertGame = db.prepare(`
    INSERT INTO games (id, date, formula, mode, author_id, created_at, submission) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertParticipation = db.prepare(`
    INSERT INTO participations (game_id, player_id, team, won, points) VALUES (?, ?, ?, ?, ?)
  `);
  const listParticipation = db.prepare(`
    SELECT player_id AS playerId, team, won, points FROM participations WHERE game_id = ? ORDER BY rowid
  `);
  const storedGame = db.prepare("SELECT * FROM games WHERE id = ?");
  const sameDay = db.prepare("SELECT id FROM games WHERE date = ? AND formula = ? AND mode = ? AND status = 'validated'");

  function appendParticipations(game) {
    for (const entry of game.participants) {
      insertParticipation.run(game.id, entry.playerId, entry.team, Number(entry.won), entry.points);
    }
  }

  const getParticipations = (id) => listParticipation.all(id).map((row) => ({ ...row, won: Boolean(row.won) }));
  function addGame(game, actor, time, submission) {
    insertGame.run(game.id, game.date, game.formula, game.mode, actor, time, submission);
    appendParticipations(game);
  }

  transaction(() => {
    if (db.prepare("SELECT 1 FROM players LIMIT 1").get()) return;
    const initial = league.initialState();
    for (const player of initial.players) insertPlayer.run(player.id, player.alias, aliasKey(player.alias), "", "");
    for (const game of initial.games) addGame(game, "x-factor", game.date + "T12:00:00Z", "fixture");
  });

  function snapshot() {
    const players = db.prepare("SELECT id, alias, motto, bio FROM players ORDER BY rowid").all();
    const games = db.prepare(`
      SELECT id, date, formula, mode, author_id AS authorId, created_at AS createdAt, status,
             ruleset_version AS rulesetVersion, revision
      FROM games ORDER BY date DESC, created_at DESC, rowid DESC
    `).all().map((game) => ({ ...game, participants: getParticipations(game.id) }));
    const corrections = db.prepare(`
      SELECT game_id AS gameId, revision, changed_at AS changedAt, actor_id AS actorId,
             reason, before_json AS beforeJson, after_json AS afterJson
      FROM corrections ORDER BY changed_at DESC, revision DESC
    `).all().map(({ beforeJson, afterJson, ...entry }) => ({
      ...entry, before: JSON.parse(beforeJson), after: JSON.parse(afterJson),
    }));
    return { players, games, corrections };
  }

  function createGame(actor, input) {
    checkActor(actor);
    if (typeof input.id !== "string" || !/^[a-f0-9]{32}$/.test(input.id)) throw new InputError("Identifiant de saisie invalide.");
    const game = parseGame(input);
    const submission = JSON.stringify(game);
    return transaction(() => {
      const previous = storedGame.get(game.id);
      if (previous) {
        if (previous.author_id !== actor || previous.submission !== submission) {
          throw new InputError("Cet identifiant correspond déjà à une autre saisie.", 409);
        }
        return snapshot();
      }
      const signature = league.resultSignature(game.participants);
      if (input.confirmDistinct !== true && sameDay.all(game.date, game.formula, game.mode)
        .some(({ id }) => league.resultSignature(getParticipations(id)) === signature)) {
        throw new InputError("Une partie identique figure déjà dans l’historique.", 409, "possible_duplicate");
      }
      addGame(game, actor, new Date().toISOString(), submission);
      return snapshot();
    });
  }

  function correctGame(actor, id, { revision, winner, reason }) {
    checkAdmin(actor);
    const note = boundedText(reason, 500, "Le motif");
    if (!note) throw new InputError("Indique le motif de la correction.");
    return transaction(() => {
      const existing = storedGame.get(id);
      if (!existing) throw new InputError("Cette partie est introuvable.", 404);
      if (existing.revision !== revision) throw new InputError("Cette partie a déjà été modifiée. Recharge l’historique.", 409);
      const before = getParticipations(id);
      const groups = league.groupsFrom(before);
      const corrected = parseGame({ id, date: existing.date, formula: existing.formula, groups, winner });
      if (JSON.stringify(before) === JSON.stringify(corrected.participants)) throw new InputError("Choisis un autre vainqueur.");

      db.prepare("DELETE FROM participations WHERE game_id = ?").run(id);
      appendParticipations(corrected);
      db.prepare("UPDATE games SET revision = revision + 1 WHERE id = ?").run(id);
      db.prepare(`
        INSERT INTO corrections (game_id, revision, changed_at, actor_id, reason, before_json, after_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, revision + 1, new Date().toISOString(), actor, note, JSON.stringify(before), JSON.stringify(corrected.participants));
      return snapshot();
    });
  }

  function updateProfile(actor, input) {
    checkActor(actor);
    const alias = boundedText(input.alias, 24, "L’alias");
    const motto = boundedText(input.motto, 90, "La devise");
    const bio = boundedText(input.bio, 240, "La présentation");
    if (!alias) throw new InputError("Choisis un alias.");
    const key = aliasKey(alias);
    return transaction(() => {
      if (db.prepare("SELECT 1 FROM players WHERE alias_key = ? AND id <> ?").get(key, actor)) {
        throw new InputError("Cet alias est déjà utilisé.", 409);
      }
      db.prepare("UPDATE players SET alias = ?, alias_key = ?, motto = ?, bio = ? WHERE id = ?").run(alias, key, motto, bio, actor);
      return snapshot();
    });
  }

  return {
    snapshot,
    createGame,
    correctGame,
    updateProfile,
    exportData(actor) {
      checkAdmin(actor);
      return { schemaVersion: 1, exportedAt: new Date().toISOString(), ...snapshot() };
    },
    close: () => db.close(),
  };
}
