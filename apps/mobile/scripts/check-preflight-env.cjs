const expected = {
  ...require("../eas.json").build.preflight.env,
  EXPO_NO_DOTENV: "1",
};

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
