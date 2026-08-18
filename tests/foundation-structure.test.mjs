import assert from "node:assert/strict";
import {readFile, readdir} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function filesBelow(directory) {
  const result = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(absolute));
    else result.push(absolute);
  }
  return result;
}

test("manifest keeps upstream identity and declares only shipped local resources", async () => {
  const manifest = JSON.parse(await readFile(path.join(repository, "system.json"), "utf8"));
  assert.equal(manifest.id, "age-system");
  assert.equal(manifest.url, "https://github.com/vkdolea/age-system");
  assert.equal(manifest.compatibility.verified, "14.366");
  assert.equal(manifest.socket, false);
  assert.equal("progression" in manifest.documentTypes.Item, false);

  for (const relative of [...manifest.styles, ...manifest.esmodules, ...manifest.languages.map(language => language.path)]) {
    await assert.doesNotReject(readFile(path.join(repository, relative)), relative);
  }
});

test("foundation source contains no local development or generated release metadata", async () => {
  const forbidden = /C:\\Users\\|D:\\|\.codex|ChatGPT|temporary-unverified|SEE-EXTERNAL-SHA256SUMS/i;
  const extensions = new Set([".js", ".json", ".hbs", ".css", ".md", ".less"]);
  for (const file of await filesBelow(repository)) {
    if (!extensions.has(path.extname(file))) continue;
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, forbidden, path.relative(repository, file));
  }
});

test("the upstream foundation does not ship the new progression implementation", async () => {
  const files = (await filesBelow(repository)).map(file => path.relative(repository, file).replaceAll("\\", "/"));
  assert.equal(files.some(file => file.startsWith("modules/progression/")), false);
  assert.equal(files.some(file => file.startsWith("templates/progression/")), false);
  assert.equal(files.some(file => /character-builder|advancement-center|progression-definition/i.test(file)), false);
});
