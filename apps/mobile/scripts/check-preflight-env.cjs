const { readFileSync } = require("node:fs");
const { parseEnv } = require("node:util");
const expected = require("../eas.json").build.preflight.env;

if (process.argv[2]) {
  const snapshot = readFileSync(process.argv[2], "utf8");
  if (/^# [^=\r\n]+=\*\*\*\*\* \(secret\)\r?$/m.test(snapshot)) {
    throw new Error("Edo Preflight cannot validate Expo preview variables with secret visibility.");
  }
  const remote = parseEnv(snapshot);
  for (const [name, value] of Object.entries(remote)) {
    if (!Object.hasOwn(expected, name) || expected[name] !== value) {
      throw new Error(`Expo preview disagrees with the committed Preflight profile for ${name}.`);
    }
  }
}

for (const [name, value] of Object.entries(expected)) {
  if (process.env[name] !== value) {
    throw new Error(`Expo preview overrides the committed Preflight variable ${name}.`);
  }
}

for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith("EXPO_PUBLIC_EDO_") && value && !Object.hasOwn(expected, name)) {
    throw new Error(`Declare the Preflight variable ${name} in the build profile.`);
  }
}
