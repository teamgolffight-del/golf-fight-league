(() => {
  const formats = ["Scramble", "Shamble", "Chouette", "Skins", "Wolf", "Match Play", "Foursome"];
  const teamCodes = ["A", "B", "C"];
  const formatId = (label) => label.toLowerCase().replaceAll(" ", "-");
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

  function recordGame({ id, date, formula, groups, winner }, roster = initialPlayers) {
    const timestamp = new Date(typeof date === "string" ? date + "T00:00:00Z" : NaN);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(timestamp.valueOf()) || timestamp.toISOString().slice(0, 10) !== date) {
      throw new Error("Choisis une date valide.");
    }
    if (!formats.includes(formula)) throw new Error("Choisis une formule.");
    if (!Array.isArray(groups) || !groups.every(Array.isArray)) throw new Error("Choisis les participants.");
    const participants = groups.flat();
    if (participants.length < 2) throw new Error("Choisis au moins deux participants.");
    if (participants.some((id) => !roster.some((player) => player.id === id && player.active !== false))) {
      throw new Error("Choisis les participants parmi les joueurs actifs.");
    }
    if (new Set(participants).size !== participants.length) throw new Error("Chaque joueur ne peut participer qu’une fois.");
    const isTeam = groups.length > 1;
    if (groups.length > teamCodes.length || (isTeam && groups.some((group) => !group.length))) {
      throw new Error("Répartis les participants dans chaque équipe.");
    }
    const twoPairs = groups.length === 2 && groups.every((group) => group.length === 2);
    if (formula === "Match Play" && !(twoPairs || (!isTeam && participants.length === 2))) {
      throw new Error("Le Match Play se joue à 1 contre 1 ou à 2 contre 2.");
    }
    if (formula === "Foursome" && !twoPairs) {
      throw new Error("Le Foursome se joue avec deux équipes de deux.");
    }
    const winners = isTeam ? groups[teamCodes.indexOf(winner)] : participants.includes(winner) ? [winner] : [];
    if (!winners?.length) throw new Error("Choisis le vainqueur.");
    return {
      id,
      date,
      formula,
      mode: isTeam ? "team" : "single",
      participants: groups.flatMap((group, index) => group.map((playerId) => ({
        playerId,
        team: isTeam ? teamCodes[index] : null,
        won: winners.includes(playerId),
        points: winners.includes(playerId) && roster.find((player) => player.id === playerId).permanent !== false ? 1 : 0,
      }))),
    };
  }

  function summarize(games, playerId) {
    const results = games.flatMap((game) => game.participants).filter((entry) => entry.playerId === playerId);
    const wins = results.filter((entry) => entry.won).length;
    return { wins, played: results.length, rate: results.length ? Math.round(wins * 100 / results.length) : null };
  }

  function rank(players, games) {
    const standings = players.filter((player) => player.permanent !== false).map((player) => ({ ...player, ...summarize(games, player.id) }));
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

  function groupsFrom(participants) {
    return participants.some((entry) => entry.team)
      ? teamCodes.filter((team) => participants.some((entry) => entry.team === team))
          .map((team) => participants.filter((entry) => entry.team === team).map((entry) => entry.playerId))
      : [participants.map((entry) => entry.playerId)];
  }

  function assignTeams(selected, teams, assignments) {
    for (const [id, team] of assignments) {
      if (!selected.includes(id) || !teams.includes(team)) assignments.delete(id);
    }
    const sizes = Object.fromEntries(teams.map((team) => [team, 0]));
    for (const team of assignments.values()) sizes[team]++;
    for (const id of selected) {
      if (assignments.has(id)) continue;
      const team = teams.reduce((smallest, candidate) => sizes[candidate] < sizes[smallest] ? candidate : smallest);
      assignments.set(id, team);
      sizes[team]++;
    }
  }

  function resultSignature(participants) {
    return JSON.stringify([...participants]
      .sort((a, b) => a.playerId.localeCompare(b.playerId))
      .map(({ playerId, team, won }) => [
        playerId,
        won,
        team ? participants.filter((entry) => entry.team === team).map((entry) => entry.playerId).sort() : null,
      ]));
  }

  const league = { formats, formatId, teamCodes, recordGame, groupsFrom, assignTeams, resultSignature, summarize, rank, initialState };
  if (typeof module === "object") module.exports = league;
  else globalThis.league = league;
})();
