// Expo config plugin — declare the app↔website association for password autofill.
//
// Android credential association is BIDIRECTIONAL:
//   1. The website hosts /.well-known/assetlinks.json delegating
//      `delegate_permission/common.get_login_creds` to this app (shipped on
//      finlynq.com + dev.finlynq.com).
//   2. The APP must declare it is associated with that site via an
//      `asset_statements` <meta-data> resource in AndroidManifest.
//
// Without (2), Google Password Manager treats the app as its own identity
// (the "finlynq" app label / com.pf.mobile package) and only offers app-scoped
// credentials — NOT the saved finlynq.com web credentials. This plugin adds the
// missing app-side declaration. Requires a rebuild (manifest is baked at build).
//
// The `include` form points the system at the website's assetlinks.json, which
// must delegate back to this app — completing the two-way Digital Asset Link.

const { withAndroidManifest, withStringsXml } = require("expo/config-plugins");

// The site whose saved web credentials should be offered in-app. The user's
// finlynq.com logins live under this origin.
const SITE = "https://finlynq.com";
const ASSET_STATEMENTS = JSON.stringify([
  { include: `${SITE}/.well-known/assetlinks.json` },
]);

module.exports = function withAssetStatements(config) {
  // 1. Add the asset_statements string resource (idempotent).
  config = withStringsXml(config, (cfg) => {
    const res = cfg.modResults.resources;
    res.string = (res.string || []).filter(
      (s) => !(s.$ && s.$.name === "asset_statements")
    );
    res.string.push({
      $: { name: "asset_statements", translatable: "false" },
      _: ASSET_STATEMENTS,
    });
    return cfg;
  });

  // 2. Reference it from a <meta-data> on <application> (idempotent).
  config = withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application[0];
    app["meta-data"] = (app["meta-data"] || []).filter(
      (m) => !(m.$ && m.$["android:name"] === "asset_statements")
    );
    app["meta-data"].push({
      $: {
        "android:name": "asset_statements",
        "android:resource": "@string/asset_statements",
      },
    });
    return cfg;
  });

  return config;
};
