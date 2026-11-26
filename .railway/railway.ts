import { defineRailway, github, project, service } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "transitya-backend";
export default defineRailway(() => {
  const transityaBackend = service("transitya-backend", {
    source: github("santiagogarcia0210/transitya-backend", { branch: "main", checkSuites: false }),
    build: { buildEnvironment: "V3", builder: "NIXPACKS" },
    start: "node index.js",
    replicas: { "sfo": 1 },
  });

  return project("thriving-wonder", {
    variables: { managed: false },
    resources: [transityaBackend],
  });
});
