const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { parsePcapNg, parseIpv4Tcp } = require("../protocol/pcapng");
const { extractHistoryCapture } = require("../protocol/nightfall");

const execFileAsync = promisify(execFile);

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function runElevatedCapture(scriptPath, action, etlPath, pcapPath) {
  const argumentList = [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-Action", action,
    "-EtlPath", etlPath,
    "-PcapPath", pcapPath,
  ];
  const serialized = argumentList.map(quotePowerShell).join(",");
  const command = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList @(${serialized})`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]);
}

async function startCapture({ scriptPath, etlPath, pcapPath }) {
  await runElevatedCapture(scriptPath, "Start", etlPath, pcapPath);
}

async function stopAndParseCapture({ scriptPath, etlPath, pcapPath }) {
  await runElevatedCapture(scriptPath, "Stop", etlPath, pcapPath);
  const buffer = await fs.readFile(pcapPath);
  const packets = parsePcapNg(buffer).map(parseIpv4Tcp).filter(Boolean);
  return extractHistoryCapture(packets);
}

async function autoPaginate({ scriptPath, clickCount = 300, delayMilliseconds = 200 }) {
  await execFileAsync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
    "-ClickCount", String(clickCount), "-DelayMilliseconds", String(delayMilliseconds),
  ], { windowsHide: true });
}

function capturePaths(baseDirectory) {
  return {
    etlPath: path.join(baseDirectory, "nightfall-gacha.etl"),
    pcapPath: path.join(baseDirectory, "nightfall-gacha.pcapng"),
  };
}

module.exports = { autoPaginate, capturePaths, runElevatedCapture, startCapture, stopAndParseCapture };
