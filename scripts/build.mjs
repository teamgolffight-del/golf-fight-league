import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const output = new URL("../build/", import.meta.url);
const demo = new URL("../demo/", import.meta.url);
const shared = new URL("../dist/", import.meta.url);
const rules = new URL("league-data.js", shared);
await rm(output, { recursive: true, force: true });
await mkdir(output);
await cp(demo, output, { recursive: true });
await cp(rules, new URL("league-data.js", output));

const sharedOutput = new URL("ligue/", output);
await cp(shared, sharedOutput, { recursive: true });
const sharedPage = new URL("index.html", sharedOutput);
const html = (await readFile(sharedPage, "utf8"))
  .replace('id="gfl-preview"', 'id="gfl-preview" data-storage="sheets"')
  .replaceAll(/src="(golf-fight-league-logo\.webp|league(?:-data)?\.js)"/g, 'src="/ligue/$1"')
  .replace("Prototype local · Données fictives", "Ligue partagée");
await writeFile(sharedPage, html);

// Only an explicit production flag replaces the homepage.
if (process.env.VERCEL_ENV === "production" && process.env.GFL_SHEETS_ENABLED === "1" &&
    process.env.GFL_SHEETS_MODE === "production") {
  const demoOutput = new URL("demo/", output);
  await cp(demo, demoOutput, { recursive: true });
  await cp(rules, new URL("league-data.js", demoOutput));
  await cp(sharedOutput, output, { recursive: true });
}
