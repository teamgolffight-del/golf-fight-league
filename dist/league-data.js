(() => {
  const formats = ["Scramble", "Shamble", "Chouette", "Skins", "Wolf"];
  const initialPlayers = [
    { id: "x-factor", alias: "X Factor" },
    { id: "captain", alias: "Captain" },
    { id: "foxy", alias: "Foxy" },
    { id: "nitro", alias: "Nitro" },
    { id: "lady", alias: "Lady" },
    { id: "fyzio", alias: "Fyzio" },
    { id: "sniper", alias: "Sniper" },
    { id: "kid", alias: "Kid" },
  ];
  const examples = [
    { date: "2026-11-12", formula: "Scramble", groups: [["captain", "foxy"], ["x-factor", "nitro"]], winner: "A" },
    { date: "2026-11-08", formula: "Wolf", groups: [["x-factor", "captain", "lady", "fyzio", "sniper"]], winner: "x-factor" },
    { date: "2026-11-01", formula: "Skins", groups: [["nitro", "foxy", "sniper", "kid"]], winner: "nitro" },
    { date: "2026-10-26", formula: "Scramble", groups: [["captain", "foxy"], ["lady", "kid"]], winner: "A" },
  ];

  function recordGame({ id, date, formula, groups, winner }) {
    const timestamp = new Date(typeof date === "string" ? date + "T00:00:00Z" : NaN);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(timestamp.valueOf()) || timestamp.toISOString().slice(0, 10) !== date) {
      throw new Error("Choisis une date valide.");
    }
    if (!formats.includes(formula)) throw new Error("Choisis une formule.");
    if (!Array.isArray(groups) || !groups.every(Array.isArray)) throw new Error("Choisis les participants.");
    const participants = groups.flat();
    if (participants.length < 2) throw new Error("Choisis au moins deux participants.");
    if (participants.some((id) => !initialPlayers.some((player) => player.id === id))) {
      throw new Error("Choisis les participants parmi les huit joueurs.");
    }
    if (new Set(participants).size !== participants.length) throw new Error("Chaque joueur ne peut participer qu’une fois.");
    const isTeam = groups.length > 1;
    if (isTeam && (groups.length !== 2 || groups.some((group) => group.length === 0))) {
      throw new Error("Répartis les participants dans les deux équipes.");
    }
    const winners = isTeam ? groups[["A", "B"].indexOf(winner)] : participants.includes(winner) ? [winner] : [];
    if (!winners?.length) throw new Error("Choisis le vainqueur.");
    return {
      id,
      date,
      formula,
      mode: isTeam ? "team" : "single",
      participants: groups.flatMap((group, index) => group.map((playerId) => ({
        playerId,
        team: isTeam ? ["A", "B"][index] : null,
        won: winners.includes(playerId),
        points: winners.includes(playerId) ? 1 : 0,
      }))),
    };
  }

  function summarize(games, playerId) {
    const results = games.flatMap((game) => game.participants).filter((entry) => entry.playerId === playerId);
    const wins = results.filter((entry) => entry.won).length;
    return { wins, played: results.length, rate: results.length ? Math.round(wins * 100 / results.length) : null };
  }

  function rank(players, games) {
    const standings = players.map((player) => ({ ...player, ...summarize(games, player.id) }));
    standings.sort((a, b) => b.wins - a.wins || a.alias.localeCompare(b.alias, "fr"));
    return standings.map((player) => ({
      ...player,
      rank: standings.findIndex((entry) => entry.wins === player.wins) + 1,
    }));
  }

  function initialState() {
    return {
      players: initialPlayers.map((player) => ({ ...player, motto: "", bio: "" })),
      games: examples.map((game, index) => recordGame({ ...game, id: "demo-" + index })),
    };
  }

  const league = { formats, recordGame, summarize, rank, initialState };
  if (typeof module === "object") module.exports = league;
  else globalThis.league = league;
})();
