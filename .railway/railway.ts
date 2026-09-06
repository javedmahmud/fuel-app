import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres4iBn = postgres("Postgres-4iBn", { region: "us-west2" });
  Postgres4iBn.deploy = { limitOverride: { containers: { cpu: 1, memoryBytes: 1000000000 } } };
  Postgres4iBn.networking = { privateNetworkEndpoint: "postgres-4ibn", tcpProxies: { "5432": {} } };
  const postgresVolumeDHsw = volume("postgres-volume-dHsw", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "us-west2",
    sizeMB: 5000,
  });
  const mellowBlessing = service("mellow-blessing", {
    source: github("javedmahmud/fuel-app", { branch: "staging", checkSuites: false }),
    replicas: { "us-west2": 1 },
    env: {
      DATABASE_URL: preserve(),
      DEFAULT_CONSUMPTION_L_100KM: preserve(),
      FRESHNESS_THRESHOLDS_JSON: preserve(),
      LOG_LEVEL: preserve(),
      REFERENCE_FILL_LITRES: preserve(),
    },
    // Runs once per deploy, before the new version takes traffic, regardless of replica count
    // — matches 14_DEPLOYMENT.md §14.5 exactly ("migrations run as a release step... not on
    // application boot"), and avoids the concurrent-migration risk of embedding this in the
    // start command instead (this service autoscales to 2 replicas per §14.2).
    preDeploy: "npm run db:migrate",
  });

  return project("focused-courage", {
    resources: [Postgres4iBn, mellowBlessing, postgresVolumeDHsw],
  });
});
