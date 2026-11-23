const TABLES = {
  Joueurs: "joueur_id alias type actif devise date_creation notes",
  Formats: "format_id libelle actif participants_min participants_max remarque",
  Parties: "partie_id date_partie format_id saison statut saisie_par cree_le modifie_le revision commentaire",
  Participations: "participation_id partie_id joueur_id equipe_id gagnant points commentaire",
  Corrections: "correction_id partie_id date_correction acteur_id champ_modifie avant_json apres_json raison revision_avant revision_apres",
  Saisons: "saison_id libelle debut fin actif",
};
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_SECONDS = 15 * 60;

class LeagueError extends Error {
  constructor(message, status = 400, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function configuration() {
  const config = PropertiesService.getScriptProperties().getProperties();
  const expectedTarget = config.GFL_MODE === "production";
  if (!["test", "production"].includes(config.GFL_MODE) ||
      !config.GFL_SPREADSHEET_ID || !config.GFL_REAL_SPREADSHEET_ID ||
      (config.GFL_SPREADSHEET_ID === config.GFL_REAL_SPREADSHEET_ID) !== expectedTarget ||
      (config.GFL_SHEETS_SECRET || "").length < 32) {
    throw new LeagueError("Le référentiel Google Sheets doit être configuré.", 503);
  }
  return config;
}

function respond(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function equalSignature(a, b) {
  if (typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function doPost(event) {
  let lock;
  try {
    const config = configuration();
    const raw = event?.postData?.contents;
    if (typeof raw !== "string" || raw.length > 16000) throw new LeagueError("Requête invalide.");
    let envelope;
    try { envelope = JSON.parse(raw); } catch { throw new LeagueError("Requête invalide."); }
    const { payload, signature } = envelope || {};
    if (typeof payload !== "string") throw new LeagueError("Requête invalide.");
    const expected = Utilities.computeHmacSha256Signature(payload, config.GFL_SHEETS_SECRET, Utilities.Charset.UTF_8)
      .map((byte) => (byte & 255).toString(16).padStart(2, "0")).join("");
    if (!equalSignature(expected, signature)) throw new LeagueError("Requête non autorisée.", 403);
    const { version, time, nonce, mode, action, actor, data, id } = JSON.parse(payload);
    if (version !== 1 || mode !== config.GFL_MODE || !Number.isSafeInteger(time) ||
        Math.abs(Date.now() - time) > 120000 || typeof nonce !== "string" || !/^[a-f0-9]{32}$/.test(nonce)) {
      throw new LeagueError("Requête expirée ou non autorisée.", 403);
    }

    lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) throw new LeagueError("Synchronisation occupée. Réessaie.", 503);
    const cache = CacheService.getScriptCache();
    if (cache.get(nonce)) throw new LeagueError("Cette requête a déjà été traitée.", 409);
    cache.put(nonce, "1", 300);

    if (action === "login") guardLogin(cache, actor, data?.client);
    const book = SpreadsheetApp.openById(config.GFL_SPREADSHEET_ID);
    const result = operate(book, action === "login" ? "snapshot" : action, actor, data, id);
    return respond({ ok: true, data: result });
  } catch (error) {
    if (error instanceof LeagueError) {
      return respond({ ok: false, status: error.status, error: error.message, code: error.code, retryAfter: error.retryAfter });
    }
    console.error(error.name || "Sheets error");
    return respond({ ok: false, status: 502, error: "Google Sheets est momentanément indisponible." });
  } finally {
    if (lock?.hasLock()) lock.releaseLock();
  }
}

function guardLogin(cache, actor, client) {
  if (typeof client !== "string" || !/^[a-f0-9]{64}$/.test(client)) throw new LeagueError("Requête invalide.");
  const key = "login:" + client;
  const now = Math.floor(Date.now() / 1000);
  let burst = JSON.parse(cache.get(key) || "null");
  if (!burst || burst.ending <= now) burst = { failures: 0, ending: now + LOGIN_WINDOW_SECONDS };
  const remaining = burst.ending - now;
  if (burst.failures >= LOGIN_LIMIT) {
    const error = new LeagueError("Trop de tentatives. Réessaie dans quelques minutes.", 429, "too_many_attempts");
    error.retryAfter = remaining;
    throw error;
  }
  if (!actor) {
    burst.failures++;
    cache.put(key, JSON.stringify(burst), remaining);
    throw new LeagueError("Profil ou code incorrect.", 401);
  }
}

function readTables(book) {
  const entries = Object.entries(TABLES);
  const ranges = entries.map(([name, schema]) => "'" + name + "'!A:" + String.fromCharCode(64 + schema.split(" ").length));
  const { valueRanges } = Sheets.Spreadsheets.Values.batchGet(book.getId(), {
    ranges, valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER",
  });
  return Object.fromEntries(entries.map(([name, schema], position) => {
    const sheet = book.getSheetByName(name);
    const columns = schema.split(" ");
    if (!sheet) throw new LeagueError("Onglet manquant : " + name, 503);
    const values = valueRanges[position]?.values || [];
    if (columns.some((header, index) => values[0]?.[index] !== header)) {
      throw new LeagueError("En-têtes incompatibles : " + name, 503);
    }
    const rows = values.slice(1).flatMap((row, index) =>
      row.every((value) => value === "") ? [] : [{ index: index + 1, values: columns.map((_, i) => row[i] ?? "") }]);
    return [name, { id: sheet.getSheetId(), rows, next: values.length, maxRows: sheet.getMaxRows() }];
  }));
}

const flag = (value) => value === true || String(value).toUpperCase() === "TRUE" || value === 1;
const sheetDate = (value) => new Date(Math.round((value - 25569) * 86400000)).toISOString();
const day = (value) => typeof value === "number" ? sheetDate(value).slice(0, 10) : String(value);
const instant = (value) => typeof value === "number" ? sheetDate(value) : String(value);
const labelKey = (value) => String(value).trim().normalize("NFC").toLowerCase();

function snapshot(tables) {
  const players = tables.Joueurs.rows.map(({ values: [id, alias, type, active, motto, , bio] }) => ({
    id: String(id), alias: String(alias), permanent: labelKey(type) === "permanent",
    active: flag(active), motto: String(motto || ""), bio: String(bio || ""),
  }));
  const formats = new Map(tables.Formats.rows.map(({ values: [id, label] }) => [String(id), String(label)]));
  const participants = new Map();
  for (const { values: [, game, player, team, won, points] } of tables.Participations.rows) {
    const entries = participants.get(String(game)) || [];
    entries.push({ playerId: String(player), team: team || null, won: flag(won), points: Number(points) });
    participants.set(String(game), entries);
  }
  const games = tables.Parties.rows.flatMap(({ values: [id, date, format, season, status, author, created, , revision] }) => {
    if (!["validated", "validé", "validée"].includes(labelKey(status))) return [];
    const entries = participants.get(String(id)) || [];
    return [{
      id: String(id), date: day(date), formula: formats.get(String(format)) || String(format), season: String(season),
      mode: entries.some((entry) => entry.team) ? "team" : "single",
      authorId: String(author), createdAt: instant(created), revision: Number(revision) || 1,
      status: "validated", participants: entries,
    }];
  }).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const corrections = tables.Corrections.rows.map(({ values: [, gameId, changedAt, actorId, , before, after, reason, , revision] }) => ({
    gameId: String(gameId), changedAt: instant(changedAt), actorId: String(actorId), reason, revision: Number(revision),
    before: JSON.parse(before), after: JSON.parse(after),
  }));
  return { players, games, corrections };
}

function changeCells(table, row, column, records) {
  const values = records.map((record) => ({
    values: record.map((value) => ({
      userEnteredValue: typeof value === "boolean" ? { boolValue: value }
        : typeof value === "number" ? { numberValue: value } : { stringValue: String(value ?? "") },
    })),
  }));
  return [
    ...(row + records.length > table.maxRows
      ? [{ appendDimension: { sheetId: table.id, dimension: "ROWS", length: row + records.length - table.maxRows } }]
      : []),
    { updateCells: { start: { sheetId: table.id, rowIndex: row, columnIndex: column }, rows: values, fields: "userEnteredValue" } },
  ];
}

function gameFrom(input, players) {
  try { return globalThis.league.recordGame(input, players); }
  catch (error) { throw new LeagueError(error.message); }
}

function requireAdmin(actor) {
  if (actor !== "x-factor") throw new LeagueError("Action réservée à l’administrateur de la League.", 403);
}

function appendGame(tables, state, actor, input) {
  if (typeof input?.id !== "string" || !/^[a-f0-9]{32}$/.test(input.id)) throw new LeagueError("Identifiant de partie invalide.");
  const earlier = state.games.find((game) => game.id === input.id);
  const roster = earlier ? state.players.map((player) => ({
    ...player, active: earlier.participants.some((entry) => entry.playerId === player.id) || player.active,
  })) : state.players;
  const game = gameFrom(input, roster);
  const signature = globalThis.league.resultSignature;
  if (earlier) {
    const firstCorrection = state.corrections.filter((entry) => entry.gameId === game.id)
      .sort((a, b) => a.revision - b.revision)[0];
    if (earlier.authorId !== actor || earlier.date !== game.date || earlier.formula !== game.formula ||
        signature(firstCorrection?.before || earlier.participants) !== signature(game.participants)) {
      throw new LeagueError("Cet identifiant correspond déjà à une autre partie.", 409);
    }
    return [];
  }
  const format = tables.Formats.rows.find(({ values }) => values[1] === input.formula && flag(values[2]));
  if (!format) throw new LeagueError("Cette formule est indisponible.");
  if (tables.Parties.rows.some(({ values }) => values[0] === game.id)) throw new LeagueError("Cet identifiant est déjà utilisé.", 409);
  if (input.confirmDistinct !== true && state.games.some((entry) =>
    entry.date === game.date && entry.formula === game.formula && signature(entry.participants) === signature(game.participants))) {
    throw new LeagueError("Une partie identique figure déjà dans l’historique.", 409, "possible_duplicate");
  }
  const season = tables.Saisons.rows.find(({ values: [, , start, end] }) => game.date >= day(start) && game.date <= day(end));
  const now = new Date().toISOString();
  return [
    ...changeCells(tables.Parties, tables.Parties.next, 0, [[game.id, game.date, format.values[0], String(season?.values[0] ?? ""),
      "validated", actor, now, now, 1, ""]]),
    ...changeCells(tables.Participations, tables.Participations.next, 0, game.participants.map((entry) =>
      [game.id + ":" + entry.playerId, game.id, entry.playerId, entry.team, entry.won, entry.points, ""])),
  ];
}

function updateGame(tables, state, actor, id, input) {
  requireAdmin(actor);
  const original = state.games.find((game) => game.id === id);
  if (!original) throw new LeagueError("Partie introuvable.", 404);
  if (original.revision !== input?.revision) throw new LeagueError("Partie déjà modifiée. Recharge l’historique.", 409);
  const reason = boundedText(input.reason, 500, "Le motif");
  if (!reason) throw new LeagueError("Indique le motif de la correction.");
  const roster = state.players.map((player) => ({ ...player, active: true }));
  const corrected = gameFrom({
    id, date: original.date, formula: original.formula, groups: globalThis.league.groupsFrom(original.participants), winner: input.winner,
  }, roster);
  if (globalThis.league.resultSignature(original.participants) === globalThis.league.resultSignature(corrected.participants)) {
    throw new LeagueError("Choisis un autre vainqueur.");
  }
  const revision = original.revision + 1;
  const now = new Date().toISOString();
  const gameRow = tables.Parties.rows.find(({ values }) => values[0] === id);
  const rows = tables.Participations.rows.filter(({ values }) => values[1] === id);
  return [
    ...changeCells(tables.Parties, gameRow.index, 7, [[now, revision]]),
    ...rows.flatMap(({ index, values }) => {
      const entry = corrected.participants.find((p) => p.playerId === values[2]);
      return changeCells(tables.Participations, index, 4, [[entry.won, entry.points]]);
    }),
    ...changeCells(tables.Corrections, tables.Corrections.next, 0, [[id + ":" + revision, id, now, actor, "vainqueur",
      JSON.stringify(original.participants), JSON.stringify(corrected.participants), reason, original.revision, revision]]),
  ];
}

function boundedText(value, limit, label) {
  if (typeof value !== "string" || value.trim().length > limit) throw new LeagueError(label + " doit contenir au maximum " + limit + " caractères.");
  return value.trim();
}

function updateProfile(tables, state, actor, input) {
  const alias = boundedText(input?.alias, 24, "L’alias");
  const motto = boundedText(input?.motto, 90, "La devise");
  const bio = boundedText(input?.bio, 240, "La présentation");
  if (!alias) throw new LeagueError("Choisis un alias.");
  if (state.players.some((player) => player.id !== actor && labelKey(player.alias) === labelKey(alias))) {
    throw new LeagueError("Cet alias est déjà utilisé.", 409);
  }
  const row = tables.Joueurs.rows.find(({ values }) => values[0] === actor);
  return [
    ...changeCells(tables.Joueurs, row.index, 1, [[alias]]),
    ...changeCells(tables.Joueurs, row.index, 4, [[motto]]),
    ...changeCells(tables.Joueurs, row.index, 6, [[bio]]),
  ];
}

function operate(book, action, actor, data, id) {
  const tables = readTables(book);
  const state = snapshot(tables);
  if (!state.players.some((player) => player.id === actor && player.active && player.permanent)) {
    throw new LeagueError("Ce joueur n’est pas autorisé.", 403);
  }
  let requests;
  switch (action) {
    case "snapshot": return state;
    case "export":
      requireAdmin(actor);
      return { schemaVersion: 1, exportedAt: new Date().toISOString(), ...state };
    case "create": requests = appendGame(tables, state, actor, data); break;
    case "correct": requests = updateGame(tables, state, actor, id, data); break;
    case "profile": requests = updateProfile(tables, state, actor, data); break;
    default: throw new LeagueError("Action inconnue.", 404);
  }
  if (!requests.length) return state;
  Sheets.Spreadsheets.batchUpdate({ requests }, book.getId());
  return snapshot(readTables(book));
}

// Run from the editor during setup, against the configured workbook only.
function ajouterFoursome() {
  const config = configuration();
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const book = SpreadsheetApp.openById(config.GFL_SPREADSHEET_ID);
    const { Formats: table } = readTables(book);
    const existing = table.rows.find(({ values }) => labelKey(values[0]) === "foursome" || labelKey(values[1]) === "foursome");
    if (existing) {
      if (existing.values[1] !== "Foursome" || !flag(existing.values[2])) {
        throw new LeagueError("Une ligne Foursome existe déjà. Vérifie son intitulé et son statut.");
      }
      return;
    }
    const requests = changeCells(table, table.next, 0, [["foursome", "Foursome", true, 4, 4, "Deux équipes de deux"]]);
    Sheets.Spreadsheets.batchUpdate({ requests }, book.getId());
  } finally {
    lock.releaseLock();
  }
}
