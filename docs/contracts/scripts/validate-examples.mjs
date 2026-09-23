import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const contractsDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const schemasDir = join(contractsDir, "schemas");
const examplesDir = join(contractsDir, "examples");
const schemaFiles = readdirSync(schemasDir).filter((name) => name.endsWith(".schema.json")).sort();
const documentSchemas = [];
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

for (const fileName of schemaFiles) {
  const schema = JSON.parse(readFileSync(join(schemasDir, fileName), "utf8"));
  ajv.addSchema(schema);
  if (fileName !== "common.schema.json") {
    documentSchemas.push({ fileName, schema });
  }
}

const expectedExampleFiles = new Set();
let failures = 0;
let checked = 0;

function reportErrors(label, errors) {
  for (const error of errors ?? []) {
    process.stderr.write(label + ": " + error.instancePath + " " + error.message + "\n");
  }
}

for (const { fileName, schema } of documentSchemas) {
  const stem = fileName.replace(/\.schema\.json$/, "");
  for (const classification of ["valid", "invalid"]) {
    const exampleName = stem + "." + classification + ".json";
    expectedExampleFiles.add(exampleName);
    const examplePath = join(examplesDir, exampleName);
    let data;
    try {
      data = JSON.parse(readFileSync(examplePath, "utf8"));
    } catch (error) {
      process.stderr.write("Could not read " + exampleName + ": " + String(error) + "\n");
      failures += 1;
      continue;
    }
    const validate = ajv.getSchema(schema.$id);
    if (!validate) {
      process.stderr.write("No compiled validator for " + schema.$id + "\n");
      failures += 1;
      continue;
    }
    const isValid = validate(data);
    const expectedValid = classification === "valid";
    checked += 1;
    if (isValid !== expectedValid) {
      process.stderr.write(exampleName + " was " + (isValid ? "accepted" : "rejected") + ", expected " + classification + "\n");
      reportErrors(exampleName, validate.errors);
      failures += 1;
    }
  }
}

for (const fileName of readdirSync(examplesDir).filter((name) => name.endsWith(".json"))) {
  if (!expectedExampleFiles.has(fileName)) {
    process.stderr.write("Unexpected example file: " + fileName + "\n");
    failures += 1;
  }
}

if (failures > 0) {
  process.stderr.write("Contract example check failed: " + failures + " issue(s), " + checked + " example(s) checked.\n");
  process.exitCode = 1;
} else {
  process.stdout.write("Contract example check passed: " + checked + " examples across " + documentSchemas.length + " document schemas.\n");
}
