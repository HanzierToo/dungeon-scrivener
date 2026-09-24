import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJavaScript } from "acorn";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parser as pythonParser } from "@lezer/python";
import luaparse from "luaparse";

const contractsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(contractsDir, "../..");
const schemasDir = join(contractsDir, "schemas");
const examplesDir = join(contractsDir, "examples");
const fixturesDir = join(repoDir, "fixtures");
const schemaFiles = readdirSync(schemasDir).filter((name) => name.endsWith(".schema.json")).sort();
const documentSchemas = [];
const schemasByFormat = new Map();
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
let failures = 0;
let checkedExamples = 0;
let checkedFixtureDocuments = 0;
let checkedFixtureReferences = 0;
let checkedScripts = 0;

function fail(label, message) {
  process.stderr.write(label + ": " + message + "\n");
  failures += 1;
}

function reportErrors(label, errors) {
  for (const error of errors ?? []) {
    process.stderr.write(label + ": " + error.instancePath + " " + error.message + "\n");
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(label, "could not read JSON: " + String(error));
    return undefined;
  }
}

for (const fileName of schemaFiles) {
  const schema = readJson(join(schemasDir, fileName), fileName);
  if (!schema) continue;
  ajv.addSchema(schema);
  if (fileName !== "common.schema.json") {
    documentSchemas.push({ fileName, schema });
    if (schema.properties?.format?.const) schemasByFormat.set(schema.properties.format.const, schema);
  }
}

const expectedExampleFiles = new Set();
for (const { fileName, schema } of documentSchemas) {
  const stem = fileName.replace(/\.schema\.json$/, "");
  for (const classification of ["valid", "invalid"]) {
    const exampleName = stem + "." + classification + ".json";
    expectedExampleFiles.add(exampleName);
    const data = readJson(join(examplesDir, exampleName), exampleName);
    if (data === undefined) continue;
    const validate = ajv.getSchema(schema.$id);
    if (!validate) {
      fail(exampleName, "no compiled validator for " + schema.$id);
      continue;
    }
    const isValid = validate(data);
    const expectedValid = classification === "valid";
    checkedExamples += 1;
    if (isValid !== expectedValid) {
      fail(exampleName, "was " + (isValid ? "accepted" : "rejected") + ", expected " + classification);
      reportErrors(exampleName, validate.errors);
    }
  }
}

const supplementalExamples = new Map([
  ["session-creation-invalid-seed.json", "urn:dungeon-scrivener:schema:v1:session-creation-failure"],
  ["session-creation-invalid-clock.json", "urn:dungeon-scrivener:schema:v1:session-creation-failure"],
  ["player-save-encode-too-large.json", "urn:dungeon-scrivener:schema:v1:player-save-operation-failure"],
  ["player-save-decode-malformed.json", "urn:dungeon-scrivener:schema:v1:player-save-operation-failure"],
]);
for (const [fileName, schemaId] of supplementalExamples) {
  expectedExampleFiles.add(fileName);
  const data = readJson(join(examplesDir, fileName), fileName);
  const validate = ajv.getSchema(schemaId);
  if (data === undefined || !validate) {
    fail(fileName, "could not load supplemental example or schema " + schemaId);
    continue;
  }
  checkedExamples += 1;
  if (!validate(data)) {
    fail(fileName, "does not satisfy " + schemaId);
    reportErrors(fileName, validate.errors);
  }
}

for (const fileName of readdirSync(examplesDir).filter((name) => name.endsWith(".json"))) {
  if (!expectedExampleFiles.has(fileName)) fail("examples", "unexpected example file " + fileName);
}

function listFiles(directory, prefix = "") {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const path = prefix ? prefix + "/" + entry.name : entry.name;
    const absolutePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      fail(path, "fixture paths may not be symbolic links");
    } else if (entry.isDirectory()) {
      paths.push(...listFiles(absolutePath, path));
    } else if (entry.isFile()) {
      paths.push(path);
    }
  }
  return paths;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
}

function isWav(bytes) {
  if (bytes.length < 44 || bytes.subarray(0, 4).toString("ascii") !== "RIFF"
      || bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.subarray(8, 12).toString("ascii") !== "WAVE") return false;
  let offset = 12;
  let format;
  let dataLength;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return false;
    const chunkId = bytes.subarray(offset, offset + 4).toString("ascii");
    const chunkLength = bytes.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > bytes.length) return false;
    if (chunkId === "fmt ") {
      if (format || chunkLength < 16) return false;
      const encoding = bytes.readUInt16LE(chunkStart);
      const channels = bytes.readUInt16LE(chunkStart + 2);
      const sampleRate = bytes.readUInt32LE(chunkStart + 4);
      const byteRate = bytes.readUInt32LE(chunkStart + 8);
      const blockAlign = bytes.readUInt16LE(chunkStart + 12);
      const bitsPerSample = bytes.readUInt16LE(chunkStart + 14);
      const supportedBits = encoding === 1 ? [8, 16, 24, 32].includes(bitsPerSample) : encoding === 3 && bitsPerSample === 32;
      if (![1, 3].includes(encoding) || channels < 1 || channels > 2 || sampleRate < 8000 || sampleRate > 192000
          || !supportedBits || blockAlign !== channels * (bitsPerSample / 8)
          || byteRate !== sampleRate * blockAlign) return false;
      format = { blockAlign };
    } else if (chunkId === "data") {
      if (dataLength !== undefined) return false;
      dataLength = chunkLength;
    }
    offset = chunkEnd + (chunkLength % 2);
    if (offset > bytes.length) return false;
  }
  return offset === bytes.length && Boolean(format) && dataLength !== undefined
    && dataLength > 0 && dataLength % format.blockAlign === 0;
}

function normalizeDisplay(text) {
  return text.normalize("NFC")
    .replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "")
    .replace(/\p{White_Space}+/gu, " ");
}

function normalizeForMatch(text) {
  return normalizeDisplay(text).toLowerCase();
}

function uniqueById(rows, label) {
  const byId = new Map();
  for (const row of rows ?? []) {
    if (!row || typeof row.id !== "string") continue;
    if (byId.has(row.id)) fail(label, "duplicate ID " + row.id);
    else byId.set(row.id, row);
  }
  return byId;
}

function collectTextSources(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (!Array.isArray(value) && value.kind === "locale-key" && typeof value.key === "string") {
    output.push(value.key);
  }
  if (Array.isArray(value)) {
    for (const child of value) collectTextSources(child, output);
  } else {
    for (const child of Object.values(value)) collectTextSources(child, output);
  }
  return output;
}

function collectStrings(value, output = []) {
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const child of value) collectStrings(child, output);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectStrings(child, output);
  }
  return output;
}

function parseCapture(value, valueType) {
  if (valueType === "string") return value;
  if (valueType === "integer") {
    if (!/^-?(0|[1-9][0-9]*)$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  if (valueType === "number") {
    if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (valueType === "boolean") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
    return undefined;
  }
  if (valueType && typeof valueType === "object" && valueType.kind === "enum") {
    return valueType.values.find((candidate) => candidate.toLowerCase() === value.toLowerCase());
  }
  return undefined;
}

function matchCommandSet(commands, rawText) {
  const hasInvalidSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(rawText);
  if (hasInvalidSurrogate || Buffer.byteLength(rawText, "utf8") > 4096 || Array.from(rawText).length > 1024 || commands.length > 256) {
    return { kind: "invalid-input", reason: "input or effective command set exceeds its contract limit" };
  }
  const displayText = normalizeDisplay(rawText);
  const foldedTokens = normalizeForMatch(rawText).split(" ").filter(Boolean);
  const displayTokens = displayText.split(" ").filter(Boolean);
  if (foldedTokens.length > 128) return { kind: "invalid-input", reason: "normalized command exceeds 128 tokens" };
  const matches = new Map();
  for (const command of commands) {
    const parameterById = new Map((command.parameters ?? []).map((parameter) => [parameter.id, parameter]));
    for (const pattern of command.patterns ?? []) {
      const patternTokens = normalizeForMatch(pattern).split(" ").filter(Boolean);
      if (patternTokens.length !== foldedTokens.length) continue;
      const captures = {};
      let matchesPattern = true;
      for (let index = 0; index < patternTokens.length; index += 1) {
        const token = patternTokens[index];
        const placeholder = /^\{([a-z][a-z0-9-]*)\}$/.exec(token);
        if (!placeholder) {
          if (token !== foldedTokens[index]) matchesPattern = false;
          if (!matchesPattern) break;
          continue;
        }
        const parameter = parameterById.get(placeholder[1]);
        const captured = parameter ? parseCapture(displayTokens[index], parameter.valueType) : undefined;
        if (captured === undefined) {
          matchesPattern = false;
          break;
        }
        captures[placeholder[1]] = captured;
      }
      if (matchesPattern) {
        matches.set(command.id, { commandId: command.id, parameters: captures });
        break;
      }
    }
  }
  if (matches.size === 0) return { kind: "no-match", normalizedText: normalizeForMatch(rawText) };
  if (matches.size > 1) {
    return {
      kind: "ambiguous",
      commandIds: [...matches.keys()].sort(),
      normalizedText: normalizeForMatch(rawText),
    };
  }
  return { kind: "matched", ...matches.values().next().value, normalizedText: normalizeForMatch(rawText) };
}

function parseScript(script, source, label) {
  try {
    if (script.language === "javascript") {
      parseJavaScript(source, { ecmaVersion: 2022, sourceType: "script" });
    } else if (script.language === "lua") {
      luaparse.parse(source, { luaVersion: "5.3" });
    } else if (script.language === "python") {
      const tree = pythonParser.parse(source);
      const cursor = tree.cursor();
      do {
        if (cursor.type.isError) fail(label, "Python parser found a syntax error at " + cursor.from);
      } while (cursor.next());
    } else {
      fail(label, "unsupported declared script language " + script.language);
    }
    checkedScripts += 1;
  } catch (error) {
    fail(label, "script syntax parse failed: " + String(error));
  }
}

function validateFixture(fixtureName) {
  const fixtureDir = join(fixturesDir, fixtureName);
  const paths = listFiles(fixtureDir);
  const files = new Map(paths.map((path) => [path, join(fixtureDir, path)]));
  const jsonPaths = paths.filter((path) => path.endsWith(".json"));
  const docs = new Map();
  for (const path of jsonPaths) {
    const data = readJson(join(fixtureDir, path), fixtureName + "/" + path);
    if (data === undefined) continue;
    let schema;
    if (path === "project.json") schema = schemasByFormat.get("dungeon-scrivener-project");
    else if (path === "world.json") schema = schemasByFormat.get("dungeon-scrivener-world");
    else if (path.startsWith("locales/")) schema = schemasByFormat.get("dungeon-scrivener-locale");
    else if (path.startsWith("saves/")) schema = schemasByFormat.get("dungeon-scrivener-player-save");
    else if (path === "compiled-scripts.json") schema = schemasByFormat.get("dungeon-scrivener-compiled-script-bundle");
    if (!schema) {
      fail(fixtureName + "/" + path, "no contract schema is assigned to this fixture JSON path");
      continue;
    }
    const validate = ajv.getSchema(schema.$id);
    const isValid = Boolean(validate?.(data));
    checkedFixtureDocuments += 1;
    if (!isValid) {
      fail(fixtureName + "/" + path, "does not satisfy " + schema.$id);
      reportErrors(fixtureName + "/" + path, validate?.errors);
    }
    docs.set(path, data);
  }

  const manifest = docs.get("project.json");
  const world = docs.get("world.json");
  if (!manifest || !world) return;
  const localePaths = [...docs.keys()].filter((path) => path.startsWith("locales/"));
  const locales = localePaths.map((path) => docs.get(path)).filter(Boolean);
  const localeByTag = new Map();
  for (const locale of locales) {
    if (localeByTag.has(locale.locale)) fail(fixtureName, "duplicate locale " + locale.locale);
    localeByTag.set(locale.locale, locale);
  }
  const defaultLocale = localeByTag.get(manifest.defaultLocale);
  if (!defaultLocale) fail(fixtureName, "defaultLocale " + manifest.defaultLocale + " has no locale file");
  for (const [path, locale] of docs) {
    if (!path.startsWith("locales/")) continue;
    const expectedPath = "locales/" + locale.locale + ".json";
    if (path !== expectedPath) fail(fixtureName + "/" + path, "filename must match locale tag as " + expectedPath);
  }
  const worldTextKeys = new Set(collectTextSources(world));
  for (const key of worldTextKeys) {
    for (const locale of locales) {
      if (!Object.hasOwn(locale.strings, key)) {
        fail(fixtureName, "locale " + locale.locale + " is missing referenced key " + key);
      }
    }
  }

  const nodes = uniqueById(world.nodes, fixtureName + "/world nodes");
  const edges = uniqueById(world.navigationEdges, fixtureName + "/navigation edges");
  const entityDefinitions = uniqueById(world.entityDefinitions, fixtureName + "/entity definitions");
  const entities = uniqueById(world.entities, fixtureName + "/entities");
  const events = uniqueById(world.eventDefinitions, fixtureName + "/event definitions");
  const rules = uniqueById(world.rules, fixtureName + "/rules");
  const conversations = uniqueById(world.conversations, fixtureName + "/conversations");
  const items = uniqueById(world.itemDefinitions, fixtureName + "/items");
  const scripts = uniqueById(world.scripts, fixtureName + "/scripts");
  const compiledBundle = docs.get("compiled-scripts.json");
  if (compiledBundle) {
    const compiledById = uniqueById(compiledBundle.scripts, fixtureName + "/compiled-scripts");
    if (compiledById.size !== scripts.size) {
      fail(fixtureName + "/compiled-scripts.json", "compiled script IDs must match this world's declarations exactly");
    }
    for (const [scriptId, declaration] of scripts) {
      const compiled = compiledById.get(scriptId);
      if (!compiled || compiled.sourcePath !== declaration.path
          || compiled.sourceLanguage !== declaration.language || compiled.entrypoint !== declaration.entrypoint) {
        fail(fixtureName + "/compiled-scripts.json", "compiled IR does not match world declaration " + scriptId);
      }
    }
  }
  const entry = nodes.get(world.entryNodeId);
  if (!entry) fail(fixtureName, "entryNodeId does not name a node");
  else if (!entry.visitable) fail(fixtureName, "entry node must be visitable");
  const reachableNodeIds = new Set(entry ? [entry.id] : []);
  let nodeReachabilityChanged = true;
  while (nodeReachabilityChanged) {
    nodeReachabilityChanged = false;
    for (const edge of world.navigationEdges ?? []) {
      if (reachableNodeIds.has(edge.fromNodeId) && !reachableNodeIds.has(edge.toNodeId)) {
        reachableNodeIds.add(edge.toNodeId);
        nodeReachabilityChanged = true;
      }
    }
  }
  function canReachNode(startId, targetId) {
    const seen = new Set([startId]);
    const queue = [startId];
    while (queue.length > 0) {
      const currentId = queue.shift();
      if (currentId === targetId) return true;
      for (const edge of world.navigationEdges ?? []) {
        if (edge.fromNodeId === currentId && !seen.has(edge.toNodeId)) {
          seen.add(edge.toNodeId);
          queue.push(edge.toNodeId);
        }
      }
    }
    return false;
  }
  const hasReachableNavigationCycle = (world.navigationEdges ?? []).some((edge) =>
    reachableNodeIds.has(edge.fromNodeId)
      && reachableNodeIds.has(edge.toNodeId)
      && canReachNode(edge.toNodeId, edge.fromNodeId)
  );

  const stateDefinitionKeys = new Set();
  for (const field of world.stateDefinitions ?? []) {
    const key = field.scopeKind + ":" + field.key;
    if (stateDefinitionKeys.has(key)) fail(fixtureName, "duplicate state definition " + key);
    stateDefinitionKeys.add(key);
  }
  const worldKeys = new Set((world.stateDefinitions ?? []).filter((field) => field.scopeKind === "world").map((field) => field.key));
  const nodeKeys = new Set((world.stateDefinitions ?? []).filter((field) => field.scopeKind === "node").map((field) => field.key));
  function matchesValueType(value, valueType) {
    if (valueType === "string") return typeof value === "string";
    if (valueType === "boolean") return typeof value === "boolean";
    if (valueType === "integer") return Number.isSafeInteger(value);
    if (valueType === "number") return typeof value === "number" && Number.isFinite(value);
    if (valueType && typeof valueType === "object" && valueType.kind === "enum") {
      return typeof value === "string" && valueType.values.includes(value);
    }
    return false;
  }
  const allowedTags = new Map();
  for (const definition of world.entityDefinitions ?? []) {
    const keys = new Set();
    for (const field of definition.fields ?? []) {
      if (keys.has(field.key)) fail(fixtureName, "entity definition " + definition.id + " repeats state field " + field.key);
      keys.add(field.key);
    }
  }
  for (const entity of world.entities ?? []) {
    const definition = entityDefinitions.get(entity.definitionId);
    if (!definition) {
      fail(fixtureName, "entity " + entity.id + " references missing definition " + entity.definitionId);
      continue;
    }
    allowedTags.set(entity.id, new Set(definition.allowedTags ?? []));
    for (const key of Object.keys(entity.state ?? {})) {
      if (!(definition.fields ?? []).some((field) => field.key === key)) fail(fixtureName, "entity " + entity.id + " has undeclared state key " + key);
    }
    for (const tag of entity.tags ?? []) {
      if (!definition.allowedTags?.includes(tag)) fail(fixtureName, "entity " + entity.id + " has disallowed initial tag " + tag);
    }
  }

  function checkStateReference(reference, label) {
    if (!reference?.scope) return;
    if (reference.scope.kind === "world" && !worldKeys.has(reference.key)) {
      fail(label, "references undeclared world state " + reference.key);
    } else if (reference.scope.kind === "node") {
      if (!nodes.has(reference.scope.ownerId)) fail(label, "references missing node " + reference.scope.ownerId);
      if (!nodeKeys.has(reference.key)) fail(label, "references undeclared node state " + reference.key);
    } else if (reference.scope.kind === "entity") {
      const entity = entities.get(reference.scope.ownerId);
      const definition = entity && entityDefinitions.get(entity.definitionId);
      if (!entity) fail(label, "references missing entity " + reference.scope.ownerId);
      else if (!definition?.fields?.some((field) => field.key === reference.key)) {
        fail(label, "references undeclared entity state " + reference.key);
      }
    }
  }

  function checkCondition(condition, label) {
    if (!condition) return;
    if (condition.kind === "all" || condition.kind === "any") {
      for (const child of condition.conditions ?? []) checkCondition(child, label);
    } else if (condition.kind === "not") {
      checkCondition(condition.condition, label);
    } else if (condition.kind === "compare-state") {
      checkStateReference(condition.left, label);
    } else if (condition.kind === "has-tag") {
      if (!entities.has(condition.entityId)) fail(label, "references missing entity " + condition.entityId);
      else if (!allowedTags.get(condition.entityId)?.has(condition.tag)) fail(label, "references undeclared entity tag " + condition.tag);
    } else if (condition.kind === "has-seen-line" || condition.kind === "has-selected-dialogue-option") {
      const conversation = conversations.get(condition.conversationId);
      if (!conversation) fail(label, "references missing conversation " + condition.conversationId);
      else if (condition.kind === "has-seen-line"
          && !(conversation.lines ?? []).some((line) => line.id === condition.lineId)) {
        fail(label, "references missing dialogue line " + condition.lineId);
      } else if (condition.kind === "has-selected-dialogue-option"
          && !(conversation.lines ?? []).some((line) => (line.options ?? []).some((option) => option.id === condition.optionId))) {
        fail(label, "references missing dialogue option " + condition.optionId);
      }
    } else if (condition.kind === "has-item") {
      if (!items.has(condition.itemId)) fail(label, "references missing item " + condition.itemId);
      if (condition.owner.kind === "entity" && !entities.has(condition.owner.ownerId)) fail(label, "references missing entity inventory owner " + condition.owner.ownerId);
      if (condition.owner.kind === "node" && !nodes.has(condition.owner.ownerId)) fail(label, "references missing node inventory owner " + condition.owner.ownerId);
    } else if (condition.kind === "at-node" && !nodes.has(condition.nodeId)) {
      fail(label, "references missing node " + condition.nodeId);
    } else if (condition.kind === "event-is" && !events.has(condition.eventId)) {
      fail(label, "references missing event " + condition.eventId);
    }
  }

  const allChoices = [];
  const allCommands = [];
  const allActionEffects = [];
  const allPhaseAndEventEffects = [];
  const assetHashes = new Set();
  const typingSoundHashes = new Set();
  const textStrings = collectStrings(world).concat(...locales.map((locale) => collectStrings(locale.strings)));
  for (const text of textStrings) {
    for (const match of text.matchAll(/!?\[\[node:([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/g)) {
      if (!nodes.has(match[1])) fail(fixtureName, "Markdown references missing node " + match[1]);
    }
    for (const match of text.matchAll(/\[\[asset:sha256:([a-f0-9]{64})/g)) assetHashes.add(match[1]);
  }

  function checkEffects(effects, label) {
    for (const effect of effects ?? []) {
      if (effect.kind === "run-script") {
        if (!scripts.has(effect.scriptId)) fail(label, "run-script references missing script " + effect.scriptId);
      } else if (effect.kind === "emit-event") {
        if (!events.has(effect.eventId)) fail(label, "references missing event " + effect.eventId);
        const definition = events.get(effect.eventId);
        const declaredFields = new Set((definition?.payloadFields ?? []).map((field) => field.key));
        for (const key of Object.keys(effect.payload ?? {})) {
          if (!declaredFields.has(key)) fail(label, "event " + effect.eventId + " has undeclared payload field " + key);
        }
        for (const key of declaredFields) {
          if (!Object.hasOwn(effect.payload ?? {}, key)) fail(label, "event " + effect.eventId + " is missing payload field " + key);
        }
      } else if (effect.kind === "navigate" && !edges.has(effect.edgeId)) {
        fail(label, "references missing navigation edge " + effect.edgeId);
      } else if ((effect.kind === "add-tag" || effect.kind === "remove-tag")) {
        if (!entities.has(effect.entityId)) fail(label, "references missing entity " + effect.entityId);
        else if (!allowedTags.get(effect.entityId)?.has(effect.tag)) fail(label, "references undeclared entity tag " + effect.tag);
      } else if (effect.kind === "add-item") {
        if (!items.has(effect.itemId)) fail(label, "references missing item " + effect.itemId);
        if (effect.owner?.kind === "entity" && !entities.has(effect.owner.ownerId)) {
          fail(label, "inventory effect references missing owner " + effect.owner.ownerId);
        }
        if (effect.owner?.kind === "node" && !nodes.has(effect.owner.ownerId)) {
          fail(label, "inventory effect references missing node owner " + effect.owner.ownerId);
        }
        if (effect.containerStackId && !(world.initialInventory ?? []).some((stack) => stack.id === effect.containerStackId)) fail(label, "inventory effect references missing container stack " + effect.containerStackId);
        for (const key of Object.keys(effect.fields ?? {})) {
          const definition = items.get(effect.itemId)?.fields?.find((field) => field.key === key);
          if (!definition) fail(label, "inventory effect has undeclared item field " + effect.itemId + ":" + key);
          else if (!matchesValueType(effect.fields[key], definition.valueType)) fail(label, "inventory effect has mistyped item field " + effect.itemId + ":" + key);
        }
      } else if (["remove-item", "use-item", "transfer-item", "equip-item", "unequip-item"].includes(effect.kind)) {
        if (!(world.initialInventory ?? []).some((stack) => stack.id === effect.stackId)) fail(label, "inventory effect references missing stack " + effect.stackId);
        if (effect.kind === "transfer-item" && effect.destination.containerStackId && !(world.initialInventory ?? []).some((stack) => stack.id === effect.destination.containerStackId)) fail(label, "inventory transfer references missing destination container stack " + effect.destination.containerStackId);
      } else if (["start-conversation", "interrupt-conversation", "resume-conversation"].includes(effect.kind)
        && !conversations.has(effect.conversationId)) {
        fail(label, "references missing conversation " + effect.conversationId);
      } else if (effect.kind === "set-state" || effect.kind === "increment-state") {
        checkStateReference(effect.target, label);
      }
    }
  }

  function checkActionSet(actionSet, label) {
    for (const choice of actionSet?.choices ?? []) {
      allChoices.push(choice);
      checkCondition(choice.condition, label + "/" + choice.id);
      if (choice.navigationEdgeId && !edges.has(choice.navigationEdgeId)) fail(label, "choice " + choice.id + " references missing edge " + choice.navigationEdgeId);
      checkEffects(choice.effects, label + "/" + choice.id);
      allActionEffects.push(...(choice.effects ?? []));
    }
    for (const command of actionSet?.commands ?? []) {
      allCommands.push(command);
      checkCondition(command.condition, label + "/" + command.id);
      if (command.navigationEdgeId && !edges.has(command.navigationEdgeId)) fail(label, "command " + command.id + " references missing edge " + command.navigationEdgeId);
      checkEffects(command.effects, label + "/" + command.id);
      allActionEffects.push(...(command.effects ?? []));
    }
  }

  checkActionSet(world.actionDefaults, fixtureName + "/actionDefaults");
  for (const node of world.nodes ?? []) {
    if (node.parentId !== null && !nodes.has(node.parentId)) fail(fixtureName, "node " + node.id + " references missing parent " + node.parentId);
    const ancestors = new Set([node.id]);
    let parentId = node.parentId;
    while (parentId !== null && nodes.has(parentId)) {
      if (ancestors.has(parentId)) {
        fail(fixtureName, "node containment cycle includes " + parentId);
        break;
      }
      ancestors.add(parentId);
      parentId = nodes.get(parentId).parentId;
    }
    for (const ruleId of node.ruleIds ?? []) if (!rules.has(ruleId)) fail(fixtureName, "node " + node.id + " references missing rule " + ruleId);
    checkActionSet(node.actions, fixtureName + "/node/" + node.id);
    for (const phase of ["entry", "revisit", "exit"]) {
      const lifecycle = node.lifecycle?.[phase];
      checkEffects(lifecycle?.effects, fixtureName + "/node/" + node.id + "/lifecycle/" + phase);
      allActionEffects.push(...(lifecycle?.effects ?? []));
    }
  }
  for (const rule of world.rules ?? []) {
    if (rule.trigger.kind === "event" && !events.has(rule.trigger.eventId)) fail(fixtureName, "rule " + rule.id + " listens to missing event " + rule.trigger.eventId);
    checkCondition(rule.condition, fixtureName + "/rule/" + rule.id);
    checkEffects(rule.effects, fixtureName + "/rule/" + rule.id);
    allPhaseAndEventEffects.push({ rule, effects: rule.effects ?? [] });
  }
  uniqueById(allChoices, fixtureName + "/choices");
  uniqueById(allCommands, fixtureName + "/commands");
  for (const conversation of world.conversations ?? []) {
    const lines = uniqueById(conversation.lines, fixtureName + "/conversation/" + conversation.id + "/lines");
    const optionIds = new Set();
    if (!lines.has(conversation.entryLineId)) fail(fixtureName, "conversation " + conversation.id + " references missing entry line " + conversation.entryLineId);
    for (const entityId of conversation.participantEntityIds ?? []) {
      if (!entities.has(entityId)) fail(fixtureName, "conversation " + conversation.id + " references missing participant " + entityId);
    }
    for (const line of conversation.lines ?? []) {
      if (!entities.has(line.speakerEntityId)) fail(fixtureName, "dialogue line " + line.id + " references missing speaker " + line.speakerEntityId);
      if (line.nextLineId && !lines.has(line.nextLineId)) fail(fixtureName, "dialogue line " + line.id + " references missing next line " + line.nextLineId);
      checkCondition(line.condition, fixtureName + "/line/" + line.id);
      for (const option of line.options ?? []) {
        if (optionIds.has(option.id)) fail(fixtureName + "/conversation/" + conversation.id, "duplicate dialogue option ID " + option.id);
        optionIds.add(option.id);
        if (option.disabledReason && (option.falsePolicy !== "disable" || !option.condition)) {
          fail(fixtureName + "/option/" + option.id, "disabledReason requires a conditional option with falsePolicy disable");
        }
        if (option.nextLineId && !lines.has(option.nextLineId)) fail(fixtureName, "dialogue option " + option.id + " references missing next line " + option.nextLineId);
        checkCondition(option.condition, fixtureName + "/option/" + option.id);
        checkEffects(option.effects, fixtureName + "/option/" + option.id);
        allActionEffects.push(...(option.effects ?? []));
      }
    }
  }
  for (const edge of world.navigationEdges ?? []) {
    if (!nodes.has(edge.fromNodeId) || !nodes.has(edge.toNodeId)) fail(fixtureName, "navigation edge " + edge.id + " has a missing endpoint");
    checkCondition(edge.condition, fixtureName + "/edge/" + edge.id);
  }
  for (const stack of world.initialInventory ?? []) {
      if (!items.has(stack.itemId)) fail(fixtureName, "initial inventory references missing item " + stack.itemId);
      if (stack.owner.kind === "entity" && !entities.has(stack.owner.ownerId)) fail(fixtureName, "initial inventory references missing owner " + stack.owner.ownerId);
      if (stack.owner.kind === "node" && !nodes.has(stack.owner.ownerId)) fail(fixtureName, "initial inventory references missing node owner " + stack.owner.ownerId);
      if (stack.containerStackId && !(world.initialInventory ?? []).some((container) => container.id === stack.containerStackId)) fail(fixtureName, "initial inventory references missing container stack " + stack.containerStackId);
  }
  const initialInventoryIds = (world.initialInventory ?? []).map((stack) => stack.id);
  if (new Set(initialInventoryIds).size !== initialInventoryIds.length) fail(fixtureName, "initial inventory has duplicate stack IDs");
  const initialById = new Map((world.initialInventory ?? []).map((stack) => [stack.id, stack]));
    for (const stack of world.initialInventory ?? []) {
      const parent = stack.containerStackId ? initialById.get(stack.containerStackId) : undefined;
      if (parent) {
        if (parent.owner.kind !== stack.owner.kind || (parent.owner.kind !== "world" && parent.owner.ownerId !== stack.owner.ownerId)) fail(fixtureName, "initial inventory container owner differs for stack " + stack.id);
        if (!items.get(parent.itemId)?.canContain) fail(fixtureName, "initial inventory parent stack is not a container " + parent.id);
        if (parent.quantity !== 1) fail(fixtureName, "initial inventory parent container stack must have quantity one " + parent.id);
      }
      let cursor = stack;
      const seen = new Set([stack.id]);
      while (cursor.containerStackId) {
        if (seen.has(cursor.containerStackId)) { fail(fixtureName, "initial inventory contains a container cycle at " + stack.id); break; }
        seen.add(cursor.containerStackId);
        const next = initialById.get(cursor.containerStackId);
        if (!next) break;
        cursor = next;
      }
    }

  for (const command of allCommands) {
    if ((command.parameters ?? []).length > 16) fail(fixtureName, "command " + command.id + " exceeds 16 parameters");
    const parameterIds = (command.parameters ?? []).map((parameter) => parameter.id);
    if (new Set(parameterIds).size !== parameterIds.length) fail(fixtureName, "command " + command.id + " has duplicate parameter IDs");
    const parameterSet = new Set(parameterIds);
    const seenPatterns = new Set();
    for (const pattern of command.patterns ?? []) {
      if (Buffer.byteLength(pattern, "utf8") > 4096) fail(fixtureName, "command " + command.id + " has a pattern exceeding 4096 UTF-8 bytes");
      const normalized = normalizeForMatch(pattern);
      if (normalized.split(" ").filter(Boolean).length > 128) fail(fixtureName, "command " + command.id + " has a pattern exceeding 128 tokens");
      if (seenPatterns.has(normalized)) fail(fixtureName, "command " + command.id + " repeats a normalized pattern");
      seenPatterns.add(normalized);
      const used = [];
      for (const token of normalized.split(" ")) {
        const placeholder = /^\{([a-z][a-z0-9-]*)\}$/.exec(token);
        if (placeholder) {
          if (!parameterSet.has(placeholder[1])) fail(fixtureName, "command " + command.id + " uses undeclared parameter " + placeholder[1]);
          used.push(placeholder[1]);
        } else if (token.includes("{") || token.includes("}")) {
          fail(fixtureName, "command " + command.id + " has a placeholder that does not occupy one whole token");
        }
      }
      for (const id of parameterIds) {
        if (used.filter((value) => value === id).length !== 1) fail(fixtureName, "command " + command.id + " must use parameter " + id + " exactly once in each pattern");
      }
    }
  }

  const scriptsById = new Map();
  for (const script of world.scripts ?? []) {
    const path = script.path;
    if (!path.startsWith("scripts/")) fail(fixtureName, "script path must be inside scripts/: " + path);
    if (!files.has(path)) {
      fail(fixtureName, "declared script file does not exist: " + path);
      continue;
    }
    const ext = script.language === "javascript" ? ".js" : script.language === "lua" ? ".lua" : script.language === "python" ? ".py" : "";
    if (!path.endsWith(ext)) fail(fixtureName, "script language does not match its file extension: " + path);
    const source = readFileSync(files.get(path), "utf8");
    scriptsById.set(script.id, { script, source });
    parseScript(script, source, fixtureName + "/" + path);
    for (const match of source.matchAll(/\bapi\.emit\s*\(\s*(['"])([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\1/g)) {
      if (!events.has(match[2])) fail(fixtureName + "/" + path, "api.emit references missing event " + match[2]);
    }
  }

  const reachableScripts = new Set();
  const reachableEvents = new Set();
  function consumeEffects(effects) {
    for (const effect of effects ?? []) {
      if (effect.kind === "run-script" && scripts.has(effect.scriptId)) reachableScripts.add(effect.scriptId);
      if (effect.kind === "emit-event" && events.has(effect.eventId)) reachableEvents.add(effect.eventId);
    }
  }
  consumeEffects(allActionEffects);
  let reachabilityChanged = true;
  while (reachabilityChanged) {
    reachabilityChanged = false;
    for (const scriptId of [...reachableScripts]) {
      const scriptSource = scriptsById.get(scriptId)?.source ?? "";
      for (const match of scriptSource.matchAll(/\bapi\.emit\s*\(\s*(['"])([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\1/g)) {
        if (!reachableEvents.has(match[2])) {
          reachableEvents.add(match[2]);
          reachabilityChanged = true;
        }
      }
    }
    for (const { rule, effects } of allPhaseAndEventEffects) {
      const phaseIsReachable = rule.trigger.kind === "phase"
        && (
          rule.trigger.phase === "action-start" && allCommands.length + allChoices.length > 0
          || rule.trigger.phase === "node-entry" && Boolean(entry)
          || rule.trigger.phase === "node-revisit" && hasReachableNavigationCycle
          || rule.trigger.phase === "node-exit" && world.navigationEdges.some((edge) => reachableNodeIds.has(edge.fromNodeId))
          || rule.trigger.phase === "time-advanced" && (
            world.settings.time.mode === "elapsed"
            || world.settings.time.mode === "per-action" && world.settings.time.millisecondsPerAction > 0
          )
        );
      const eventIsReachable = rule.trigger.kind === "event" && reachableEvents.has(rule.trigger.eventId);
      if (!phaseIsReachable && !eventIsReachable) continue;
      const previousScriptCount = reachableScripts.size;
      const previousEventCount = reachableEvents.size;
      consumeEffects(effects);
      if (reachableScripts.size !== previousScriptCount || reachableEvents.size !== previousEventCount) {
        reachabilityChanged = true;
      }
    }
  }
  for (const scriptId of scripts.keys()) {
    if (!reachableScripts.has(scriptId)) fail(fixtureName, "declared script is not reachable from an action, lifecycle, phase rule, or emitted-event rule: " + scriptId);
  }

  for (const path of paths.filter((value) => value.startsWith("assets/sha256/"))) {
    const hash = path.slice("assets/sha256/".length);
    if (!/^[a-f0-9]{64}$/.test(hash)) fail(fixtureName + "/" + path, "managed asset filename must be a lowercase SHA-256 digest");
    else if (sha256(readFileSync(files.get(path))) !== hash) fail(fixtureName + "/" + path, "managed asset bytes do not match their SHA-256 filename");
  }
  for (const effect of world.settings.typingSounds?.mappings ?? []) {
    assetHashes.add(effect.assetHash);
    typingSoundHashes.add(effect.assetHash);
  }
  if (world.settings.typingSounds?.fallback.kind === "asset") {
    assetHashes.add(world.settings.typingSounds.fallback.assetHash);
    typingSoundHashes.add(world.settings.typingSounds.fallback.assetHash);
  }
  for (const hash of assetHashes) {
    const path = "assets/sha256/" + hash;
    if (!files.has(path)) fail(fixtureName, "references missing managed asset " + hash);
  }
  for (const hash of typingSoundHashes) {
    const path = "assets/sha256/" + hash;
    if (files.has(path) && !isWav(readFileSync(files.get(path)))) fail(fixtureName, "typing-sound asset is not a WAV file: " + hash);
  }
  const typingTargets = new Set();
  for (const mapping of world.settings.typingSounds?.mappings ?? []) {
    const targetKey = mapping.target.kind === "key" ? "key:" + mapping.target.code : "group:" + mapping.target.group;
    if (typingTargets.has(targetKey)) fail(fixtureName, "duplicate typing-sound target " + targetKey);
    typingTargets.add(targetKey);
  }

  for (const { rule } of allPhaseAndEventEffects) {
    if (rule.trigger.kind === "event" && !events.has(rule.trigger.eventId)) fail(fixtureName, "unresolved rule event " + rule.trigger.eventId);
  }

  const playablePaths = new Set(["project.json", "world.json", ...localePaths]);
  for (const script of world.scripts ?? []) playablePaths.add(script.path);
  for (const hash of assetHashes) playablePaths.add("assets/sha256/" + hash);
  if (world.settings.playerStylePath) playablePaths.add(world.settings.playerStylePath);
  const fingerprintFiles = [];
  let canFingerprint = true;
  for (const path of playablePaths) {
    if (!files.has(path)) {
      canFingerprint = false;
      fail(fixtureName, "playable fingerprint includes missing file " + path);
      continue;
    }
    const bytes = readFileSync(files.get(path));
    fingerprintFiles.push({
      path,
      byteLength: bytes.length,
      sha256: sha256(bytes),
    });
  }
  fingerprintFiles.sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")));
  for (const hash of typingSoundHashes) {
    if (!fingerprintFiles.some((file) => file.path === "assets/sha256/" + hash)) fail(fixtureName, "typing-sound asset is absent from the playable fingerprint: " + hash);
  }
  const fingerprintInput = {
    format: "dungeon-scrivener-content-fingerprint-input",
    schemaVersion: 1,
    algorithm: "sha-256",
    scope: "playable-files-v1",
    files: fingerprintFiles,
  };
  const contentFingerprint = canFingerprint
    ? "sha256:" + sha256(Buffer.from(canonicalJson(fingerprintInput), "utf8"))
    : undefined;

  const saveDocs = [...docs.entries()].filter(([path]) => path.startsWith("saves/"));
  const compatibleSave = docs.get("saves/compatible-save.json");
  const legacySave = docs.get("saves/incompatible-game-version-save.json");
  if (fixtureName === "tavern-at-dusk" && (saveDocs.length !== 2 || !compatibleSave || !legacySave)) {
    fail(fixtureName, "expected compatible-save and incompatible-game-version-save contract examples");
  }
  for (const [path, save] of saveDocs) {
    const label = fixtureName + "/" + path;
    if (readFileSync(files.get(path)).length > 8 * 1024 * 1024) fail(label, "save JSON exceeds the 8 MiB expanded member limit");
    if (Buffer.byteLength(canonicalJson(save.session), "utf8") > 8 * 1024 * 1024) fail(label, "serialized session exceeds the 8 MiB session limit");
    if (save.projectId !== manifest.projectId) fail(fixtureName + "/" + path, "save projectId differs from project manifest");
    if (!nodes.has(save.session.currentNodeId)) fail(label, "currentNodeId references a missing node");
    if (save.session.randomnessMode !== world.settings.randomness.mode) fail(fixtureName + "/" + path, "save randomnessMode differs from world settings");
    const hasSeedState = save.session.randomInitialSeed !== null && save.session.randomSeed !== null;
    if (save.session.randomnessMode === "seeded" ? !hasSeedState : save.session.randomInitialSeed !== null || save.session.randomSeed !== null) {
      fail(label, "randomnessMode, randomInitialSeed, and current randomSeed disagree");
    }
    if (save.session.randomnessMode === "seeded" && save.session.randomOutcomes.length > 0) fail(label, "seeded saves must not contain unseeded outcomes");
    for (const [key, value] of Object.entries(save.session.state.world)) {
      const definition = (world.stateDefinitions ?? []).find((field) => field.scopeKind === "world" && field.key === key);
      if (!definition) fail(label, "saved world state contains undeclared key " + key);
      else if (!matchesValueType(value, definition.valueType)) fail(label, "saved world state has the wrong value type for " + key);
    }
    for (const [nodeId, values] of Object.entries(save.session.state.nodes)) {
      if (!nodes.has(nodeId)) fail(label, "saved node state references missing node " + nodeId);
      for (const [key, value] of Object.entries(values)) {
        const definition = (world.stateDefinitions ?? []).find((field) => field.scopeKind === "node" && field.key === key);
        if (!definition) fail(label, "saved node state contains undeclared key " + nodeId + ":" + key);
        else if (!matchesValueType(value, definition.valueType)) fail(label, "saved node state has the wrong value type for " + nodeId + ":" + key);
      }
    }
    for (const [entityId, values] of Object.entries(save.session.state.entities)) {
      const entity = entities.get(entityId);
      const definition = entity && entityDefinitions.get(entity.definitionId);
      if (!entity) fail(label, "saved entity state references missing entity " + entityId);
      for (const [key, value] of Object.entries(values)) {
        const field = definition?.fields?.find((candidate) => candidate.key === key);
        if (!field) fail(label, "saved entity state contains undeclared key " + entityId + ":" + key);
        else if (!matchesValueType(value, field.valueType)) fail(label, "saved entity state has the wrong value type for " + entityId + ":" + key);
      }
    }
    for (const nodeId of Object.keys(save.session.nodeVisitCounts)) {
      if (!nodes.has(nodeId)) fail(label, "nodeVisitCounts references missing node " + nodeId);
    }
    for (const ruleId of Object.keys(save.session.ruleGuards)) {
      if (!rules.has(ruleId)) fail(label, "ruleGuards references missing rule " + ruleId);
    }
    const contexts = [
      ...(save.session.activeConversation === null ? [] : [save.session.activeConversation]),
      ...save.session.conversationStack,
    ];
    const contextKey = (context) => JSON.stringify([
      context.conversationId,
      context.lineId,
      context.returnNodeId,
    ]);
    if (save.session.conversationStack.length > 64) fail(label, "conversationStack exceeds 64 suspended contexts");
    if (save.session.activeConversation && save.session.conversationStack.some((context) => contextKey(context) === contextKey(save.session.activeConversation))) {
      fail(label, "activeConversation duplicates a suspended conversation context");
    }
    for (const context of contexts) {
      const conversation = conversations.get(context.conversationId);
      const contextLabel = context === save.session.activeConversation ? "activeConversation" : "conversationStack";
      if (!conversation) fail(label, contextLabel + " references missing conversation " + context.conversationId);
      else if (!(conversation.lines ?? []).some((line) => line.id === context.lineId)) {
        fail(label, contextLabel + " references missing line " + context.conversationId + ":" + context.lineId);
      }
      if (!nodes.has(context.returnNodeId)) fail(label, contextLabel + " references missing return node " + context.returnNodeId);
    }
    for (const entry of save.session.dialogueHistory) {
      const conversation = conversations.get(entry.conversationId);
      const line = conversation?.lines?.find((candidate) => candidate.id === entry.lineId);
      if (!conversation) fail(label, "dialogueHistory references missing conversation " + entry.conversationId);
      else if (!line) fail(label, "dialogueHistory references missing line " + entry.conversationId + ":" + entry.lineId);
      else if (entry.kind === "option-selected" && !(line.options ?? []).some((option) => option.id === entry.optionId)) {
        fail(label, "dialogueHistory references missing option " + entry.conversationId + ":" + entry.lineId + ":" + entry.optionId);
      }
    }
    for (const stack of save.session.inventory) {
      if (!items.has(stack.itemId)) fail(label, "inventory references missing item " + stack.itemId);
      if (stack.owner.kind === "entity" && !entities.has(stack.owner.ownerId)) fail(label, "inventory references missing entity owner " + stack.owner.ownerId);
      if (stack.owner.kind === "node" && !nodes.has(stack.owner.ownerId)) fail(label, "inventory references missing node owner " + stack.owner.ownerId);
      if (stack.containerStackId && !save.session.inventory.some((container) => container.id === stack.containerStackId)) fail(label, "inventory references missing container stack " + stack.containerStackId);
      const item = items.get(stack.itemId);
      if (item && stack.quantity > item.stackLimit) fail(label, "inventory stack exceeds item stack limit " + stack.id);
      if (stack.equippedSlot && (item?.equipmentSlot !== stack.equippedSlot || stack.quantity !== 1)) fail(label, "inventory has invalid equipped slot on stack " + stack.id);
      if (stack.containerStackId) {
        const parent = save.session.inventory.find((candidate) => candidate.id === stack.containerStackId);
        if (parent && !items.get(parent.itemId)?.canContain) fail(label, "inventory parent stack is not a container " + parent.id);
        if (parent && parent.quantity !== 1) fail(label, "inventory parent container stack must have quantity one " + parent.id);
        if (parent && (parent.owner.kind !== stack.owner.kind || (parent.owner.kind !== "world" && parent.owner.ownerId !== stack.owner.ownerId))) fail(label, "inventory container owner differs for stack " + stack.id);
      }
      const fieldKeys = new Set((item?.fields ?? []).map((field) => field.key));
      for (const [key, value] of Object.entries(stack.fields)) {
        const field = item?.fields?.find((candidate) => candidate.key === key);
        if (!fieldKeys.has(key)) fail(label, "inventory has undeclared item field " + stack.itemId + ":" + key);
        else if (!matchesValueType(value, field.valueType)) fail(label, "inventory has the wrong value type for " + stack.itemId + ":" + key);
      }
    }
    if (new Set(save.session.inventory.map((stack) => stack.id)).size !== save.session.inventory.length) fail(label, "inventory has duplicate stack IDs");
    const equippedKeys = save.session.inventory.filter((stack) => stack.equippedSlot).map((stack) => JSON.stringify([stack.owner, stack.equippedSlot]));
    if (new Set(equippedKeys).size !== equippedKeys.length) fail(label, "inventory equips more than one stack into the same owner slot");
    const maxGeneratedOrdinal = Math.max(-1, ...save.session.inventory.map((stack) => /^stack-(\d+)$/.exec(stack.id)).filter(Boolean).map((match) => Number(match[1])));
    if (save.session.nextInventoryStackOrdinal <= maxGeneratedOrdinal) fail(label, "nextInventoryStackOrdinal would reuse an existing generated stack ID");
    for (const stack of save.session.inventory) {
      const seen = new Set([stack.id]);
      let cursor = stack;
      while (cursor.containerStackId) {
        if (seen.has(cursor.containerStackId)) { fail(label, "inventory contains a container cycle at " + stack.id); break; }
        seen.add(cursor.containerStackId);
        const next = save.session.inventory.find((candidate) => candidate.id === cursor.containerStackId);
        if (!next) break;
        cursor = next;
      }
    }
    for (const outcome of save.session.randomOutcomes) {
      if (save.session.randomnessMode !== "unseeded") fail(label, "only unseeded draws may be stored as random outcomes");
      if (!scripts.has(outcome.sourceScriptId)) fail(label, "random outcome references missing source script " + outcome.sourceScriptId);
    }
    for (let index = 0; index < save.session.randomOutcomes.length; index += 1) {
      if (save.session.randomOutcomes[index].ordinal !== index) fail(label, "random outcome ordinals must be contiguous from zero");
    }
    const expectedEntityIds = [...entities.keys()].sort();
    const savedEntityIds = Object.keys(save.session.entityTags ?? {}).sort();
    if (expectedEntityIds.join("|") !== savedEntityIds.join("|")) fail(fixtureName + "/" + path, "entityTags must persist every known entity exactly once");
    for (const [entityId, tags] of Object.entries(save.session.entityTags ?? {})) {
      const tagSet = allowedTags.get(entityId) ?? new Set();
      if ([...tags].join("|") !== [...tags].sort().join("|")) fail(fixtureName + "/" + path, "entity tags must be sorted for " + entityId);
      for (const tag of tags) if (!tagSet.has(tag)) fail(fixtureName + "/" + path, "entityTags contains disallowed tag " + entityId + ":" + tag);
    }
    if (world.settings.time.mode === "elapsed" && save.session.clockState.lastObservedEpochMilliseconds === null) {
      fail(fixtureName + "/" + path, "elapsed-time save must persist its clock baseline");
    }
    if (world.settings.time.mode === "per-action") {
      if (save.session.clockState.lastObservedEpochMilliseconds !== null || save.session.clockState.inactiveSinceEpochMilliseconds !== null) {
        fail(label, "per-action save must use null clock baselines");
      }
    } else {
      const { visibility, focused, lastObservedEpochMilliseconds, inactiveSinceEpochMilliseconds } = save.session.clockState;
      const active = visibility === "visible" && focused;
      if (active && inactiveSinceEpochMilliseconds !== null) fail(label, "active elapsed-time save cannot have an inactive interval baseline");
      if (!active && inactiveSinceEpochMilliseconds === null) fail(label, "inactive elapsed-time save must persist its inactive interval baseline");
      if (inactiveSinceEpochMilliseconds !== null && inactiveSinceEpochMilliseconds > lastObservedEpochMilliseconds) {
        fail(label, "inactive interval baseline cannot be later than last clock observation");
      }
    }
  }
  if (compatibleSave) {
    if (compatibleSave.gameVersion !== manifest.gameVersion) fail(fixtureName, "compatible save gameVersion must copy project.json gameVersion");
    if (compatibleSave.contentFingerprint !== contentFingerprint) {
      fail(fixtureName, "compatible save fingerprint differs from computed fixture content: expected " + contentFingerprint);
    }
  }
  if (compatibleSave && legacySave) {
    const mismatches = ["projectId", "gameVersion", "engineVersion", "contentFingerprint"]
      .filter((key) => compatibleSave[key] !== legacySave[key]);
    if (mismatches.join("|") !== "gameVersion") fail(fixtureName, "legacy save must differ from compatible save only in gameVersion; found " + mismatches.join(","));
    if (legacySave.gameVersion === manifest.gameVersion) fail(fixtureName, "legacy save must have an incompatible gameVersion");
  }

  if (fixtureName === "tavern-at-dusk") {
    const commands = world.nodes.find((node) => node.id === "tavern-hall")?.actions?.commands ?? [];
    const acceptedInteger = matchCommandSet(commands, "COUNT   CANDLES 3");
    if (acceptedInteger.kind !== "matched" || acceptedInteger.commandId !== "count-candles" || acceptedInteger.parameters.count !== 3) {
      fail(fixtureName, "typed integer command example did not resolve strictly");
    }
    const rejectedInteger = matchCommandSet(commands, "count candles two");
    if (rejectedInteger.kind !== "no-match") fail(fixtureName, "invalid integer command example must be no-match");
    const ambiguous = matchCommandSet(commands, "count candles 2");
    if (ambiguous.kind !== "ambiguous" || ambiguous.commandIds.join("|") !== "count-candles|count-candles-two") {
      fail(fixtureName, "overlapping command example must return a code-point-sorted ambiguity");
    }
    const normalizedString = matchCommandSet(commands, "  ASK   ABOUT   RAiN  ");
    if (normalizedString.kind !== "matched" || normalizedString.commandId !== "ask-about-topic" || normalizedString.parameters.topic !== "RAiN") {
      fail(fixtureName, "one-token string command example did not preserve normalized source spelling");
    }
    const overLimit = matchCommandSet(commands, "x".repeat(4097));
    if (overLimit.kind !== "invalid-input") fail(fixtureName, "over-limit raw command input must be rejected without truncation");
  }

  checkedFixtureReferences += 1;
  process.stdout.write(
    "Fixture " + fixtureName + ": " + jsonPaths.length + " JSON documents, "
      + scriptsById.size + " reachable scripts, " + typingSoundHashes.size + " typing-sound asset(s), fingerprint "
      + (contentFingerprint ?? "unavailable") + "\n"
  );
}

for (const fixtureName of readdirSync(fixturesDir).filter((name) => statSync(join(fixturesDir, name)).isDirectory()).sort()) {
  validateFixture(fixtureName);
}

if (failures > 0) {
  process.stderr.write(
    "Contract check failed: " + failures + " issue(s), " + checkedExamples + " schema examples, "
      + checkedFixtureDocuments + " fixture documents, " + checkedScripts + " script parses.\n"
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Contract check passed: " + checkedExamples + " schema examples, "
      + checkedFixtureDocuments + " fixture documents, " + checkedFixtureReferences + " fixtures, "
      + checkedScripts + " syntax-only script parses. No fixture script was executed.\n"
  );
}
