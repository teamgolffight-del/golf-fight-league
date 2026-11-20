import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { InputError, openLeague } from "./storage.mjs";

const assets = new Map([
  ["/", ["index.html", "text/html"]],
  ["/index.html", ["index.html", "text/html"]],
  ["/league-data.js", ["league-data.js", "text/javascript"]],
  ["/league.js", ["league.js", "text/javascript"]],
]);

function reply(response, code, type, data) {
  response.writeHead(code, {
    "Content-Type": type + "; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(data);
}

function json(response, code, data) {
  reply(response, code, "application/json", JSON.stringify(data));
}

async function readJSON(request) {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
    throw new InputError("Envoie des données JSON.", 415);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 16_384) {
      request.resume();
      throw new InputError("La saisie est trop volumineuse.", 413);
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks));
  } catch {
    throw new InputError("La saisie est invalide.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("La saisie est invalide.");
  return value;
}

export function createLeagueServer(filename) {
  const store = openLeague(filename);
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, "http://localhost").pathname;
      const method = request.method;
      const actor = request.headers["x-league-demo-player"];
      if (method === "GET" && assets.has(path)) {
        const [file, type] = assets.get(path);
        const data = await readFile(new URL("./dist/" + file, import.meta.url));
        return reply(response, 200, type, data);
      }
      if (method === "GET" && path === "/api/league") return json(response, 200, store.snapshot());
      if (method === "GET" && path === "/api/export") return json(response, 200, store.exportData(actor));
      if (method === "POST" && path === "/api/games") {
        return json(response, 200, store.createGame(actor, await readJSON(request)));
      }
      const correction = method === "PATCH" && path.match(/^\/api\/games\/([a-z0-9-]+)$/);
      if (correction) return json(response, 200, store.correctGame(actor, correction[1], await readJSON(request)));
      if (method === "PATCH" && path === "/api/profile") {
        return json(response, 200, store.updateProfile(actor, await readJSON(request)));
      }
      return json(response, 404, { error: "Page introuvable." });
    } catch (error) {
      if (error instanceof InputError) return json(response, error.status, { error: error.message, code: error.code });
      console.error(error);
      return json(response, 500, { error: "Une erreur est survenue. Réessaie." });
    }
  });
  server.on("close", store.close);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const filename = fileURLToPath(new URL("./data/league.sqlite", import.meta.url));
  const port = Number(process.env.PORT || 4173);
  const server = createLeagueServer(filename);
  server.listen(port, "127.0.0.1", () => {
    console.log("GOLF FIGHT LEAGUE · http://127.0.0.1:" + server.address().port);
  });
}
