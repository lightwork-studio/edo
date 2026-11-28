const preflightProject = "fd9dba15-d0b8-4594-a2b0-aed4cc0a0b7a";

module.exports = ({ config }) => {
  if (process.env.EDO_APP_VARIANT !== "preflight") return config;

  return {
    ...config,
    name: "Edo Preflight",
    owner: "webertim",
    version: "0.1.0",
    ios: {
      ...config.ios,
      buildNumber: "2",
      infoPlist: { ...config.ios?.infoPlist, ITSAppUsesNonExemptEncryption: false },
    },
    runtimeVersion: { policy: "fingerprint" },
    updates: { url: `https://u.expo.dev/${preflightProject}` },
    extra: { ...config.extra, eas: { projectId: preflightProject } },
  };
};
