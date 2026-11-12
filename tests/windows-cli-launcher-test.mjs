import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

if (process.platform === "win32") {
  test("packaged ccodex showcase renders the shared guide without creating a profile or workspace", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex showcase-"));
    const source = path.resolve(import.meta.dirname, "..");
    const workspace = path.join(directory, "not-created-workspace");
    const profile = path.join(directory, "not-created-profile");
    const version = fs.readFileSync(path.join(source, "VERSION"), "utf8").trim();
    try {
      const result = spawnSync("cmd.exe", [
        "/d", "/s", "/c",
        `""${path.join(source, "bin", "ccodex.cmd")}" showcase"`,
      ], {
        cwd: directory,
        env: {
          ...process.env,
          USERPROFILE: directory,
          CCODEX_WORKSPACE: workspace,
          CODEX_COPILOT_HOME: profile,
          CODEX_COPILOT_SHOWCASE_URL: "",
          CODEX_COPILOT_NONINTERACTIVE: "1",
          CODEX_COPILOT_NO_ANIMATION: "1",
        },
        encoding: "utf8",
        windowsHide: true,
        windowsVerbatimArguments: true,
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      if (fs.existsSync(path.join(source, "release.json"))) {
        assert.match(result.stdout, /CCODEX \/ TEAM RELEASE/);
        assert.match(result.stdout, /Model \/ Context \/ Effort/);
        assert.match(result.stdout, /FIRST RUN/);
        assert.ok(result.stdout.includes(`ccodex ${version}`));
      } else {
        assert.match(result.stdout, /✦ CODEX COPILOT/);
        assert.match(result.stdout, /Model → Context → Effort/);
        assert.match(result.stdout, /INSTALL FINISHED/);
        assert.match(result.stdout, /展示来源：包内快照/);
        assert.ok(result.stdout.includes(`v${version}`));
      }
      assert.equal(fs.existsSync(workspace), false);
      assert.equal(fs.existsSync(profile), false);

      const legacyShell = spawnSync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-File", path.join(source, "tools", "showcase.ps1"),
      ], {
        cwd: directory,
        env: {
          ...process.env,
          USERPROFILE: directory,
          CODEX_COPILOT_SHOWCASE_URL: "",
          CODEX_COPILOT_NONINTERACTIVE: "1",
          CODEX_COPILOT_NO_ANIMATION: "1",
        },
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
      });
      assert.equal(legacyShell.status, 0, `${legacyShell.stdout}\n${legacyShell.stderr}`);
      assert.match(legacyShell.stdout, /✦ CODEX COPILOT/);
      assert.ok(legacyShell.stdout.includes(`v${version}`));
    } finally {
      assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
      assert.match(path.basename(directory), /^ccodex showcase-/);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Windows launcher selects the isolated CLI profile/catalog without inheriting Desktop defaults", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex win launcher-"));
    const bin = path.join(root, "bin");
    const bridge = path.join(root, "bridge");
    const tools = path.join(root, "tools");
    const profile = path.join(root, "isolated profile");
    for (const directory of [bin, bridge, tools, profile]) fs.mkdirSync(directory);
    const source = path.resolve(import.meta.dirname, "..");
    const launcher = path.join(bin, "codex-copilot.cmd");
    const core = path.join(bin, "mock-core.cmd");
    const argsFile = path.join(root, "received-args.txt");
    fs.copyFileSync(path.join(source, "bin", "codex-copilot.cmd"), launcher);
    fs.writeFileSync(path.join(bin, "core-current.txt"), `${core}\n`);
    fs.writeFileSync(core, [
      "@echo off",
      `> "%MOCK_ARGS_FILE%" echo %*`,
      "exit /b 0",
      "",
    ].join("\r\n"));
    fs.writeFileSync(path.join(tools, "native-runtime.mjs"), "process.exit(0);\n");
    fs.writeFileSync(path.join(bridge, "ensure.mjs"), "process.exit(0);\n");
    fs.writeFileSync(path.join(bridge, "port-selection.mjs"), "console.log(22690);\n");
    fs.writeFileSync(path.join(bridge, "cli-session.mjs"), [
      'import fs from "node:fs";',
      `import {prepareCliSettings} from ${JSON.stringify(
        pathToFileURL(path.join(source, "bridge", "surface-settings.mjs")).href)};`,
      `import {cliSessionArguments,cliSessionEnvironment} from ${JSON.stringify(
        pathToFileURL(path.join(source, "bridge", "cli-session.mjs")).href)};`,
      'prepareCliSettings(process.env.CODEX_COPILOT_HOME);',
      'const args=cliSessionArguments(process.env.CODEX_COPILOT_HOME,process.argv.slice(3));',
      'const env=cliSessionEnvironment(process.env);',
      'fs.writeFileSync(process.env.MOCK_ARGS_FILE,JSON.stringify({args,watcher:env.CODEX_COPILOT_SELECTION_FILE||null}));',
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(profile, "config.toml"),
      'model = "gpt-test--long-context"\n');

    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)/i.test(key)) delete env[key];
    }
    Object.assign(env, {
      CODEX_HOME: profile,
      CODEX_COPILOT_HOME: profile,
      MOCK_ARGS_FILE: argsFile,
    });
    try {
      const call = () => {
        const result = spawnSync("cmd.exe", [
          "/d", "/s", "/c", `""${launcher}" exec --isolated-probe"`,
        ], {
          cwd: root, env, encoding: "utf8", windowsHide: true,
          windowsVerbatimArguments: true, timeout: 15000,
        });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        return JSON.parse(fs.readFileSync(argsFile, "utf8"));
      };
      const first = call();
      assert.deepEqual(first.args.slice(0, 3), ["--profile", "ccodex", "-c"]);
      assert.equal(first.args[3], `model_catalog_json=${JSON.stringify(path.join(profile, "models.json"))}`);
      assert.deepEqual(first.args.slice(4), ["exec", "--isolated-probe"]);
      assert.equal(first.watcher, null);
      const isolatedFile = path.join(profile, "ccodex.config.toml");
      const selected = fs.readFileSync(isolatedFile, "utf8");
      assert.match(selected, /^model\s*=\s*"gpt-test"/m);
      assert.match(selected, /^service_tier\s*=\s*"context-long"/m);
      fs.writeFileSync(path.join(profile, "config.toml"),
        'model = "other--default-context"\nmodel_reasoning_effort = "low"\n');
      assert.deepEqual(call(), first);
      assert.equal(fs.readFileSync(isolatedFile, "utf8"), selected);
    } finally {
      assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
      assert.ok(path.basename(root).startsWith("ccodex win launcher-"));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("Windows ccodex keeps credits/history JSON and redirected native output free of terminal escapes", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex plain-output-"));
    const bin = path.join(directory, "bin");
    fs.mkdirSync(bin);
    const source = path.resolve(import.meta.dirname, "..");
    const alias = path.join(bin, "ccodex.cmd");
    fs.copyFileSync(path.join(source, "bin", "ccodex.cmd"), alias);
    fs.writeFileSync(path.join(bin, "codex-copilot.cmd"), [
      "@echo off",
      'if /i "%MOCK_OUTPUT_KIND%"=="ascii" (',
      "    echo [===---------] AI credits",
      ") else (",
      '    echo {"unit":"credits","noColor":"%NO_COLOR%"}',
      ")",
      "exit /b %MOCK_EXIT_CODE%",
      "",
    ].join("\r\n"));
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(CODEX|CCODEX|OPENAI|GITHUB|COPILOT)_/.test(key) ||
          /(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)/i.test(key)) delete env[key];
    }
    Object.assign(env, {
      USERPROFILE: directory,
      CODEX_COPILOT_HOME: path.join(directory, "not-created-profile"),
      CCODEX_NO_CD: "1",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      MOCK_EXIT_CODE: "0",
      MOCK_OUTPUT_KIND: "json",
    });
    try {
      const call = args => spawnSync("cmd.exe", [
        "/d", "/s", "/c", `""${alias}" ${args}"`,
      ], {
        cwd: directory, env, encoding: "utf8", windowsHide: true,
        windowsVerbatimArguments: true, timeout: 15000,
      });
      for (const args of ["credits --json", "history list --json", "exec --json"]) {
        const result = call(args);
        assert.equal(result.status, 0, result.stderr);
        assert.doesNotMatch(result.stdout, /[^\x20-\x7e\r\n]/);
        const value = JSON.parse(result.stdout);
        assert.equal(value.unit, "credits");
        assert.equal(value.noColor, "1");
      }
      env.MOCK_OUTPUT_KIND = "ascii";
      const ascii = call("credits --ascii");
      assert.equal(ascii.status, 0, ascii.stderr);
      assert.equal(ascii.stdout.trim(), "[===---------] AI credits");
      env.MOCK_EXIT_CODE = "37";
      assert.equal(call("exec --json").status, 37, "Preserve the native command's exit code.");
      assert.equal(fs.existsSync(env.CODEX_COPILOT_HOME), false);
    } finally {
      assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
      assert.match(path.basename(directory), /^ccodex plain-output-/);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
