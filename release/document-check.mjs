import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { releaseEnvironment, releaseRoot } from "./environment.mjs";

export const DOCUMENT_CHECK_TIMEOUT_MS = 240000;
export const PYTHON_RPC_CHECK_TIMEOUT_MS = 120000;

export async function checkDocuments({ primary, root = releaseRoot, home } = {}) {
  const dependencies = path.join(primary, "dependencies");
  const env = releaseEnvironment({ root, home });
  fs.mkdirSync(env.TEMP, { recursive: true });
  const output = fs.mkdtempSync(path.join(env.TEMP, "document-check-"));
  const require = createRequire(path.join(dependencies, "node", "package.json"));
  try {
    process.stderr.write("Document check: native canvas and ICU.\n");
    const napi = require("@napi-rs/canvas");
    const canvas = napi.createCanvas(160, 60);
    canvas.getContext("2d").fillText("CCodex \u6587\u6863", 8, 24);
    assert(canvas.toBuffer("image/png").length > 100);
    process.stderr.write("Document check: loading the fixed JavaScript artifact runtime.\n");
    const { Workbook, SpreadsheetFile, Presentation, PresentationFile } = await import(pathToFileURL(
      path.join(dependencies, "node", "node_modules", "@oai", "artifact-tool", "dist", "artifact_tool.mjs"),
    ).href);
    process.stderr.write("Document check: spreadsheet rendering and XLSX roundtrip.\n");
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Check");
    sheet.getRange("A1:B2").values = [["CCodex", "Count"], ["Private", 42]];
    const rendered = await workbook.render({ sheetName: "Check", range: "A1:B2", format: "png", scale: 1 });
    assert((await rendered.arrayBuffer()).byteLength > 100);
    const xlsx = await SpreadsheetFile.exportXlsx(workbook);
    await xlsx.save(path.join(output, "check.xlsx"));
    const imported = await SpreadsheetFile.importXlsx(xlsx);
    assert.equal(imported.worksheets.getItemAt(0).getRange("B2").values[0][0], 42);
    process.stderr.write("Document check: presentation rendering, PDF and PPTX roundtrip.\n");
    const presentation = Presentation.create({ slideSize: { width: 320, height: 180 } });
    const slide = presentation.slides.add();
    const shape = slide.shapes.add({
      geometry: "textbox", position: { left: 10, top: 10, width: 300, height: 70 },
      fill: "none", line: { fill: "none", width: 0 },
    });
    shape.text = "CCodex document check";
    shape.text.style = { fontSize: 18 };
    assert((await (await presentation.export({ slide, format: "png", scale: 1 })).arrayBuffer()).byteLength > 100);
    assert((await (await presentation.export({ format: "pdf" })).arrayBuffer()).byteLength > 100);
    const pptx = await PresentationFile.exportPptx(presentation);
    await pptx.save(path.join(output, "check.pptx"));
    assert.equal((await PresentationFile.importPptx(pptx)).slides.items.length, 1);
    process.stderr.write("Document check: private Python RPC and file exports.\n");
    const python = path.join(dependencies, "python");
    const pythonEnv = {
      ...env, PYTHONHOME: path.toNamespacedPath(python),
      PYTHONPATH: ["Lib", "DLLs", path.join("Lib", "site-packages")]
        .map(file => path.toNamespacedPath(path.join(python, file))).join(path.delimiter),
      ARTIFACT_TOOL_RPC_DAEMON_STARTUP_TIMEOUT_S: "45",
    };
    const result = spawnSync(path.join(python, "python.exe"), ["-X", "utf8", "-c",
      "from pathlib import Path; import sys; from artifact_tool_v2 import Workbook, SpreadsheetFile, Presentation, PresentationFile; " +
      "p=Path(sys.argv[1]); w=Workbook.create(); s=w.worksheets.add('Check'); s.get_range('A1').values=[[42]]; " +
      "SpreadsheetFile.export_xlsx(w).save(p/'python.xlsx'); d=Presentation.create({'slide_size':{'width':320,'height':180}}); " +
      "d.slides.add(); PresentationFile.export_pptx(d).save(p/'python.pptx'); " +
      "assert (p/'python.xlsx').read_bytes().startswith(b'PK'); assert (p/'python.pptx').read_bytes().startswith(b'PK'); print('python-rpc-ready')",
      output], {
      env: pythonEnv, cwd: root, encoding: "utf8", windowsHide: true,
      timeout: PYTHON_RPC_CHECK_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    assert(result.stdout.includes("python-rpc-ready"));
    return { canvasIcu: true, pngPdf: true, xlsxPptxRoundTrips: true, pythonRpc: true, networkRequired: false };
  } finally {
    const relative = path.relative(env.TEMP, output);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      fs.rmSync(output, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const primary = process.argv[2] || path.join(releaseRoot, "runtime", "primary", "codex-primary-runtime");
    console.log(JSON.stringify(await checkDocuments({ primary, home: process.argv[3] || path.join(os.tmpdir(), "ccodex-document-check") })));
  } catch (error) {
    console.error(`Document runtime check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
