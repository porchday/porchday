/** Manual-only GitHub macOS runner. Raw output/credentials never leave RUNNER_TEMP. */
import { chmod, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { HostedIOSError, readHostedFixture, configureHostedTestRun, verifyNativeTestResult, nativeFailureCode, nativeFailureDiagnostic } from "./hosted-ios-support.ts";

const execute = promisify(execFile);
let directory = "", simulator = "", phase = "PREFLIGHT", failure = "", cleanupFailed = false;
let diagnostic: string | null = null;
const cleanEnv = { ...process.env };
const encoded = process.env.PORCHDAY_IOS_HOSTED_FIXTURE_B64 ?? "";
delete process.env.PORCHDAY_IOS_HOSTED_FIXTURE_B64;
for (const key of Object.keys(cleanEnv)) if (key.startsWith("PORCHDAY_HOSTED_") || key.startsWith("PORCHDAY_IOS_HOSTED_")) delete cleanEnv[key];

async function capture(program: string, args: string[], timeout = 30_000): Promise<string> {
  const result = await execute(program, args, { env: cleanEnv, timeout, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout;
}
async function recorded(program: string, args: string[], timeout: number, input?: string): Promise<number> {
  const log = await open(join(directory, "private-command.log"), "a", 0o600);
  try {
    return await new Promise((accept, reject) => {
      const child = spawn(program, args, { env: cleanEnv, stdio: ["pipe", log.fd, log.fd] });
      const timer = setTimeout(() => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 2_000).unref(); }, timeout);
      child.on("error", () => { clearTimeout(timer); reject(new HostedIOSError("COMMAND_START_FAILED")); });
      child.on("close", code => { clearTimeout(timer); accept(code ?? 1); });
      child.stdin.on("error", () => {}); child.stdin.end(input);
    });
  } finally { await log.close(); }
}
async function logTail(): Promise<string> {
  const file = await open(join(directory, "private-command.log"), "r");
  try { const info = await file.stat(); const bytes = Buffer.alloc(Math.min(info.size, 65_536)); await file.read(bytes, 0, bytes.length, Math.max(0, info.size - bytes.length)); return bytes.toString("utf8"); }
  finally { await file.close(); }
}
function requireValue(value: unknown, code: string): asserts value { if (!value) throw new HostedIOSError(code); }

try {
  requireValue(process.argv.slice(2).join(" ") === "--run", "RUN_FLAG_REQUIRED");
  requireValue(process.env.GITHUB_ACTIONS === "true" && process.platform === "darwin", "EPHEMERAL_MACOS_RUNNER_REQUIRED");
  readHostedFixture(encoded);
  const runner = await realpath(process.env.RUNNER_TEMP ?? "");
  const workspace = await realpath(resolve("."));
  requireValue(runner !== workspace && !runner.startsWith(workspace + sep), "PRIVATE_RUNNER_DIRECTORY_REQUIRED");
  directory = await mkdtemp(join(runner, "porchday-hosted-ios-")); await chmod(directory, 0o700);

  phase = "SIMULATOR";
  const inventory = JSON.parse(await capture("xcrun", ["simctl", "list", "--json"]));
  let pair: { runtime: string; type: string } | undefined;
  for (const [runtime, devices] of Object.entries(inventory.devices) as [string, any[]][]) {
    if (!runtime.includes(".iOS-")) continue;
    const device = devices.find(row => row.isAvailable && row.name.startsWith("iPhone"));
    if (!device) continue;
    const type = device.deviceTypeIdentifier ?? inventory.devicetypes.find((row: any) => row.name === device.name)?.identifier;
    if (type) { pair = { runtime, type }; break; }
  }
  requireValue(pair, "IPHONE_SIMULATOR_UNAVAILABLE");
  simulator = (await capture("xcrun", ["simctl", "create", "Porchday-Hosted-" + randomUUID(), pair.type, pair.runtime])).trim();
  requireValue(/^[A-F0-9-]{36}$/i.test(simulator), "SIMULATOR_ID_INVALID");

  phase = "BUILD";
  const derived = join(directory, "DerivedData"), destination = "platform=iOS Simulator,id=" + simulator;
  requireValue(await recorded("xcodebuild", ["-project", "apps/ios/Porchday.xcodeproj", "-scheme", "Porchday", "-configuration", "Debug", "-destination", destination, "-derivedDataPath", derived, "CODE_SIGNING_ALLOWED=NO", "build-for-testing"], 15 * 60_000) === 0, "BUILD_FAILED");
  const products = join(derived, "Build", "Products");
  const manifests = (await readdir(products)).filter(name => name.endsWith(".xctestrun"));
  requireValue(manifests.length === 1, "XCTESTRUN_NOT_FOUND");
  const manifest = join(products, manifests[0]);
  const raw = JSON.parse(await capture("python3", ["-c", "import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1],'rb'))))", manifest]));
  const configured = configureHostedTestRun(raw, encoded);
  requireValue(await recorded("python3", ["-c", "import json,os,plistlib,sys; p=sys.argv[1]; os.chmod(p,0o600); plistlib.dump(json.load(sys.stdin),open(p,'wb'))", manifest], 30_000, JSON.stringify(configured)) === 0, "XCTESTRUN_WRITE_FAILED");
  // A queued or slow build must not turn a short-lived fixture into an open-ended test.
  readHostedFixture(encoded);

  phase = "TEST";
  const resultPath = join(directory, "Hosted.xcresult");
  const code = await recorded("xcodebuild", ["test-without-building", "-xctestrun", manifest, "-destination", destination, "-only-testing:PorchdayTests/HostedInteropTests/testHostedInteroperability", "-parallel-testing-enabled", "NO", "-maximum-concurrent-test-simulator-destinations", "1", "-test-timeouts-enabled", "YES", "-default-test-execution-time-allowance", "480", "-maximum-test-execution-time-allowance", "600", "-resultBundlePath", resultPath, "CODE_SIGNING_ALLOWED=NO"], 12 * 60_000);
  if (code !== 0) {
    const tail = await logTail(); diagnostic = nativeFailureDiagnostic(tail);
    throw new HostedIOSError(nativeFailureCode(tail) ?? "NATIVE_TEST_FAILED");
  }

  phase = "RESULT";
  const root = JSON.parse(await capture("xcrun", ["xcresulttool", "get", "object", "--legacy", "--format", "json", "--path", resultPath]));
  const ids: string[] = [...new Set<string>((root.actions?._values ?? []).map((action: any) => action.actionResult?.testsRef?.id?._value).filter((value: unknown): value is string => typeof value === "string" && value.length <= 256))];
  requireValue(ids.length > 0 && ids.length <= 4, "NATIVE_RESULT_REFERENCES");
  const trees = [];
  for (const id of ids) trees.push(JSON.parse(await capture("xcrun", ["xcresulttool", "get", "object", "--legacy", "--format", "json", "--path", resultPath, "--id", id])));
  verifyNativeTestResult(root, trees);
} catch (error) {
  // No provider/body/command/error message is printed unless it was our fixed code.
  failure = error instanceof HostedIOSError ? error.message : "HOSTED_IOS_OPERATION_FAILED";
} finally {
  if (simulator) {
    try { await capture("xcrun", ["simctl", "shutdown", simulator]); } catch { /* It may already be shut down. */ }
    try { await capture("xcrun", ["simctl", "delete", simulator]); } catch { cleanupFailed = true; }
  }
  if (directory) try { await rm(directory, { recursive: true, force: true }); } catch { cleanupFailed = true; }
}
if (failure || cleanupFailed) {
  console.error(JSON.stringify({ step: "hosted-native", result: "failed", phase, code: failure || "PRIVATE_CLEANUP_FAILED", ...(diagnostic ? {diagnostic} : {}), cleanup: !cleanupFailed }));
  process.exitCode = 1;
} else console.log(JSON.stringify({ step: "hosted-native", result: "passed", tests: 1, cleanup: true }));
