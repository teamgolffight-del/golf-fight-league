(() => {
  const { rank, recordGame, summarize, teamCodes, assignTeams, initialState } = globalThis.league;
  const root = document.querySelector("#gfl-preview");
  const shared = root.dataset.storage === "sheets";
  const find = (selector) => root.querySelector(selector);
  const nav = root.querySelectorAll("nav [data-go]");
  const views = root.querySelectorAll("[data-view]");
  const savedMessage = find("#gfl-save-status");
  const playerFilter = find("#gfl-filter-player");
  const formulaFilter = find("#gfl-filter-formula");
  const periodFilter = find("#gfl-filter-period");
  const history = find("#gfl-history-results");
  const gameForm = find("#gfl-example-form");
  const appAlert = find("#gfl-app-alert");
  const playerPicker = find("#gfl-demo-player");
  const login = find("#gfl-login");
  const loginForm = login.querySelector("form");
  const exportButton = find("#gfl-export");
  const gameMessage = find("#gfl-game-feedback");
  const confirm = find("#gfl-confirm-game");
  const teamCountField = find("#gfl-team-count");
  const teamFields = find("#gfl-team-fields");
  const teamList = find("#gfl-teams");
  const winnerLabel = find("#gfl-winner-label");
  const { mode, winner, date, formula, teamCount } = gameForm.elements;
  const profile = find("#gfl-profile-form");
  const profileMessage = profile.querySelector(".gfl-feedback");
  const teamByPlayer = new Map();
  const dateFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeZone: "UTC" });
  const monthFormat = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
  const correctionTime = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" });
  let currentPlayer = "x-factor";
  let pendingGame;
  let state = { players: [], games: [], corrections: [] };
  let refreshing = false;

  async function request(path, { method = "GET", data } = {}) {
    const headers = shared ? {} : { "X-League-Demo-Player": currentPlayer };
    if (data !== undefined) headers["Content-Type"] = "application/json";
    const endpoint = shared ? "/api/league?route=" + encodeURIComponent(path) : path;
    let response;
    let result;
    try {
      response = await fetch(endpoint, {
        method,
        headers,
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      result = await response.json();
    } catch {
      throw new Error("Connexion indisponible. Vérifie le réseau puis réessaie.");
    }
    if (!response.ok) {
      const error = new Error(result.error || "L’opération a échoué.");
      error.status = response.status;
      error.code = result.code;
      throw error;
    }
    return result;
  }

  function announce(message = "", error = false) {
    appAlert.textContent = message;
    appAlert.toggleAttribute("data-error", error);
  }

  function displayDate(value) {
    return dateFormat.format(new Date(value + "T00:00:00Z"));
  }

  function alias(id) {
    return state.players.find((player) => player.id === id)?.alias || id;
  }

  function plural(count, singular) {
    return count + " " + singular + (count === 1 ? "" : "s");
  }

  function winnersText(participants) {
    return participants
      .filter((entry) => entry.won)
      .map((entry) => alias(entry.playerId) + " +" + entry.points)
      .join(" · ");
  }

  function sortedGames() {
    return [...state.games].sort((a, b) => b.date.localeCompare(a.date));
  }

  function renderHistory() {
    const filtered = sortedGames().filter((game) =>
      (!playerFilter.value || game.participants.some((p) => p.playerId === playerFilter.value)) &&
      (!formulaFilter.value || game.formula === formulaFilter.value) &&
      game.date.startsWith(periodFilter.value)
    );
    history.replaceChildren();
    if (!filtered.length) {
      history.textContent = "Aucune confrontation pour ces filtres.";
      return;
    }
    for (const game of filtered) {
      const article = document.createElement("article");
      article.className = "gfl-box";
      const title = document.createElement("h3");
      title.textContent = game.formula + " · " + displayDate(game.date);
      const participants = document.createElement("p");
      participants.className = "gfl-small";
      if (game.mode === "team") {
        participants.textContent = teamCodes.filter((team) => game.participants.some((p) => p.team === team)).map((team) =>
          team + " : " + game.participants.filter((p) => p.team === team).map((p) => alias(p.playerId)).join(", ")
        ).join(" / ");
      } else {
        participants.textContent = game.participants.map((p) => alias(p.playerId)).join(", ");
      }
      const result = document.createElement("p");
      result.className = "gfl-win";
      result.textContent = winnersText(game.participants);
      article.append(title, participants, result);
      for (const entry of state.corrections.filter((correction) => correction.gameId === game.id)) {
        const note = document.createElement("p");
        note.className = "gfl-small";
        note.textContent = "Correction par " + alias(entry.actorId) + " · " + correctionTime.format(new Date(entry.changedAt)) + " · " + entry.reason
          + " · " + winnersText(entry.before) + " → " + winnersText(entry.after);
        article.append(note);
      }
      if (currentPlayer === "x-factor") article.append(correctionEditor(game));
      history.append(article);
    }
  }

  function correctionEditor(game) {
    const details = document.createElement("details");
    details.innerHTML = `
      <summary>Corriger le vainqueur</summary>
      <form class="gfl-stack">
        <label class="gfl-field">Vainqueur corrigé<select name="winner" required><option value="">Choisir</option></select></label>
        <label class="gfl-field">Motif<textarea name="reason" maxlength="500" required></textarea></label>
        <button class="gfl-action" type="submit">Enregistrer la correction</button>
        <p class="gfl-feedback" data-error role="status"></p>
      </form>`;
    const form = details.querySelector("form");
    const choice = form.elements.winner;
    if (game.mode === "team") {
      for (const team of new Set(game.participants.filter((entry) => !entry.won).map((entry) => entry.team))) {
        const members = game.participants.filter((entry) => entry.team === team).map((entry) => alias(entry.playerId));
        choice.add(new Option("Équipe " + team + " · " + members.join(", "), team));
      }
    } else {
      for (const entry of game.participants.filter((entry) => !entry.won)) {
        choice.add(new Option(alias(entry.playerId), entry.playerId));
      }
    }
    const button = form.querySelector("button");
    const feedback = form.querySelector("[role=status]");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      button.disabled = true;
      feedback.textContent = "";
      try {
        state = await request("/api/games/" + game.id, {
          method: "PATCH",
          data: { winner: choice.value, revision: game.revision, reason: form.elements.reason.value },
        });
        renderDashboard();
        announce("Correction enregistrée. Classement mis à jour.");
      } catch (error) {
        feedback.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
    return details;
  }

  function renderDashboard() {
    const standings = rank(state.players, state.games);
    for (const body of root.querySelectorAll("[data-ranking]")) {
      body.replaceChildren();
      const isFull = body.dataset.ranking === "full";
      for (const player of isFull ? standings : standings.slice(0, 4)) {
        const row = body.insertRow();
        const rankCell = row.insertCell();
        rankCell.textContent = player.rank;
        if (player.rank <= 3) rankCell.className = "gfl-podium-rank";
        const name = document.createElement("th");
        name.scope = "row";
        name.textContent = player.alias;
        row.append(name);
        row.insertCell().textContent = player.wins;
        if (isFull) {
          row.insertCell().textContent = player.played;
          row.insertCell().textContent = player.rate === null ? "—" : player.rate + " %";
        }
      }
    }
    const games = sortedGames();
    const latest = games[0];
    if (latest) {
      const latestDate = find("#gfl-last-date");
      latestDate.dateTime = latest.date;
      latestDate.textContent = displayDate(latest.date);
      find("#gfl-last-info").textContent = latest.formula + " · " + plural(latest.participants.length, "joueur");
      find("#gfl-last-winners").textContent = winnersText(latest.participants);
    }
    const playerChoice = playerFilter.value;
    const periodChoice = periodFilter.value;
    playerFilter.replaceChildren(new Option("Tous", ""));
    playerPicker.replaceChildren();
    for (const player of state.players) {
      playerFilter.add(new Option(player.alias, player.id));
      playerPicker.add(new Option(player.alias, player.id));
      const label = find("#gfl-name-" + player.id);
      if (label) label.textContent = player.alias;
    }
    playerPicker.value = currentPlayer;
    exportButton.hidden = currentPlayer !== "x-factor";
    playerFilter.value = playerChoice;
    periodFilter.replaceChildren(new Option("Toutes les dates", ""));
    const months = new Set(games.map((game) => game.date.slice(0, 7)));
    for (const month of months) periodFilter.add(new Option(monthFormat.format(new Date(month + "-01T00:00:00Z")), month));
    periodFilter.value = months.has(periodChoice) ? periodChoice : "";
    renderHistory();

    const me = standings.find((player) => player.id === currentPlayer);
    if (!me) return;
    find("#gfl-profile-alias").textContent = me.alias;
    find("#gfl-profile-stats").textContent = [
      "Rang " + me.rank,
      plural(me.wins, "victoire") + " en " + plural(me.played, "partie"),
      me.rate === null ? null : me.rate + " %",
    ].filter(Boolean).join(" · ");
    const stats = find("#gfl-profile-formats");
    stats.replaceChildren();
    for (const format of globalThis.league.formats) {
      const { wins, played } = summarize(games.filter((game) => game.formula === format), currentPlayer);
      if (!played) continue;
      const line = document.createElement("p");
      line.className = "gfl-small";
      line.textContent = format + " · " + plural(wins, "victoire") + " en " + plural(played, "partie");
      stats.append(line);
    }
    for (const name of ["alias", "motto", "bio"]) profile.elements[name].value = me[name];
  }

  function goTo(view, moveFocus) {
    for (const section of views) section.hidden = section.dataset.view !== view;
    for (const item of nav) {
      if (item.dataset.go === view) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
    if (moveFocus) {
      const current = find('[data-view="' + view + '"]');
      const heading = current.querySelector("h2");
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }

  for (const button of root.querySelectorAll("[data-go]")) {
    button.addEventListener("click", () => {
      if (button.dataset.player) {
        playerFilter.value = button.dataset.player;
        formulaFilter.value = "";
        periodFilter.value = "";
        renderHistory();
      }
      goTo(button.dataset.go, true);
      if (shared) refreshLeague();
    });
  }
  for (const filter of [playerFilter, formulaFilter, periodFilter]) filter.addEventListener("change", renderHistory);

  const playerList = find("#gfl-players");
  function createPlayerCheckboxes() {
    playerList.replaceChildren();
    for (const player of state.players.filter((entry) => entry.active !== false)) {
      const label = document.createElement("label");
      label.className = "gfl-check";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = player.id;
      const name = document.createElement("span");
      name.id = "gfl-name-" + player.id;
      name.textContent = player.alias;
      label.append(input, name);
      playerList.append(label);
    }
  }
  const selectedPlayers = () => Array.from(playerList.querySelectorAll("input:checked"), (input) => input.value);

  function today() {
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type).value).join("-");
  }

  const fixedTeams = () => formula.value === "Match Play" || formula.value === "Foursome";
  const selectedTeams = () => teamCodes.slice(0, fixedTeams() ? 2 : Number(teamCount.value));

  function renderForm() {
    const selected = selectedPlayers();
    mode.disabled = formula.value === "Foursome";
    if (mode.disabled) mode.value = "team";
    mode.options[0].textContent = formula.value === "Match Play" ? "1 contre 1" : "Individuel";
    mode.options[1].textContent = fixedTeams() ? "2 contre 2" : "Par équipe";
    const byTeam = mode.value === "team";
    const teams = selectedTeams();
    const earlierWinner = winner.value;
    teamCountField.hidden = !byTeam || fixedTeams();
    teamFields.hidden = !byTeam || !selected.length;
    teamList.replaceChildren();
    if (byTeam) {
      assignTeams(selected, teams, teamByPlayer);
      for (const id of selected) {
        const label = document.createElement("label");
        label.className = "gfl-field";
        const select = document.createElement("select");
        for (const team of teams) select.add(new Option("Équipe " + team, team));
        select.value = teamByPlayer.get(id);
        select.addEventListener("change", () => teamByPlayer.set(id, select.value));
        label.append(alias(id), select);
        teamList.append(label);
      }
    }
    winnerLabel.textContent = byTeam ? "Équipe gagnante" : "Joueur vainqueur";
    winner.replaceChildren(new Option("Choisir", ""));
    for (const value of byTeam ? teams : selected) {
      winner.add(new Option(byTeam ? "Équipe " + value : alias(value), value));
    }
    if (Array.from(winner.options).some((option) => option.value === earlierWinner)) winner.value = earlierWinner;
  }

  function clearGamePreview() {
    gameMessage.textContent = "";
    gameMessage.removeAttribute("data-error");
    confirm.hidden = true;
    confirm.textContent = "Enregistrer la partie";
    pendingGame = undefined;
  }

  playerList.addEventListener("change", renderForm);
  mode.addEventListener("change", renderForm);
  formula.addEventListener("change", renderForm);
  teamCount.addEventListener("change", () => {
    teamByPlayer.clear();
    renderForm();
  });
  gameForm.addEventListener("change", clearGamePreview);
  gameForm.addEventListener("submit", (event) => {
    event.preventDefault();
    clearGamePreview();
    const selected = selectedPlayers();
    const groups = mode.value === "team"
      ? selectedTeams().map((team) => selected.filter((id) => teamByPlayer.get(id) === team))
      : [selected];
    try {
      const identifier = Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16).padStart(8, "0")).join("");
      const input = { date: date.value, formula: formula.value, groups, winner: winner.value, id: identifier };
      gameMessage.textContent = winnersText(recordGame(input, state.players).participants);
      pendingGame = input;
      confirm.hidden = false;
      confirm.focus();
    } catch (error) {
      gameMessage.setAttribute("data-error", "");
      gameMessage.textContent = error.message;
    }
  });

  confirm.addEventListener("click", async () => {
    if (!pendingGame || confirm.disabled) return;
    const input = pendingGame;
    confirm.disabled = true;
    try {
      state = await request("/api/games", { method: "POST", data: input });
      clearGamePreview();
      gameForm.reset();
      teamByPlayer.clear();
      date.value = today();
      renderForm();
      renderDashboard();
      savedMessage.textContent = "Partie enregistrée. Classement mis à jour.";
      goTo("home", true);
    } catch (error) {
      if (pendingGame !== input) return;
      if (error.code === "possible_duplicate") {
        pendingGame = { ...input, confirmDistinct: true };
        confirm.textContent = "Confirmer une partie distincte";
      }
      gameMessage.setAttribute("data-error", "");
      gameMessage.textContent = error.message;
    } finally {
      confirm.disabled = false;
    }
  });

  profile.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fields = new FormData(profile);
    const button = profile.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      state = await request("/api/profile", { method: "PATCH", data: Object.fromEntries(fields) });
      renderDashboard();
      renderForm();
      clearGamePreview();
      profileMessage.textContent = "Fiche enregistrée.";
      profileMessage.removeAttribute("data-error");
    } catch (error) {
      profileMessage.setAttribute("data-error", "");
      profileMessage.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  playerPicker.addEventListener("change", () => {
    currentPlayer = playerPicker.value;
    find("[data-player]").dataset.player = currentPlayer;
    profileMessage.textContent = "";
    announce();
    clearGamePreview();
    renderDashboard();
  });

  exportButton.addEventListener("click", async () => {
    exportButton.disabled = true;
    try {
      const data = await request("/api/export");
      const link = document.createElement("a");
      const file = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      link.href = URL.createObjectURL(file);
      link.download = "golf-fight-league-" + today() + ".json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (error) {
      announce(error.message, true);
    } finally {
      exportButton.disabled = false;
    }
  });

  function showLeague(initial) {
    state = initial;
    if (shared) {
      currentPlayer = initial.viewerId;
      login.hidden = true;
      root.querySelector("nav").hidden = false;
      const member = find("#gfl-signed-in");
      member.hidden = false;
      member.textContent = "Connecté · " + alias(currentPlayer);
      find("[data-player]").dataset.player = currentPlayer;
      goTo("home", false);
    }
    createPlayerCheckboxes();
    date.value = today();
    renderForm();
    renderDashboard();
    playerPicker.disabled = shared;
    announce();
  }

  function canRefresh() {
    const view = find('nav [aria-current="page"]')?.dataset.go;
    return !document.hidden && state.viewerId && ["home", "ranking", "history"].includes(view) &&
      (view !== "history" || !history.querySelector("details[open]"));
  }

  async function refreshLeague() {
    if (refreshing || !canRefresh()) return;
    const previous = state;
    refreshing = true;
    try {
      const latest = await request("/api/league");
      if (state !== previous || !canRefresh()) return;
      if (JSON.stringify(latest) !== JSON.stringify(previous)) {
        state = latest;
        renderDashboard();
      }
      if (appAlert.hasAttribute("data-error")) announce();
    } catch (error) {
      announce(error.message, true);
    } finally {
      refreshing = false;
    }
  }

  if (shared) {
    find("#gfl-demo-picker").hidden = true;
    root.querySelector("nav").hidden = true;
    for (const section of views) section.hidden = true;
    for (const member of initialState().players) loginForm.elements.player.add(new Option(member.alias, member.id));
    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = loginForm.querySelector("button");
      button.disabled = true;
      const { player, code } = Object.fromEntries(new FormData(loginForm));
      try {
        showLeague(await request("/api/session", { method: "POST", data: { player, code } }));
      } catch (error) {
        announce(error.message, true);
      } finally {
        loginForm.elements.code.value = "";
        button.disabled = false;
      }
    });
    document.addEventListener("visibilitychange", refreshLeague);
    window.setInterval(refreshLeague, 60000);
  }

  async function start() {
    try {
      showLeague(await request("/api/league"));
    } catch (error) {
      if (shared && error.status === 401) {
        login.hidden = false;
        announce();
      } else {
        announce(shared ? error.message : "La League est indisponible. Démarre le serveur local et recharge la page.", true);
      }
    }
  }

  start();
})();
