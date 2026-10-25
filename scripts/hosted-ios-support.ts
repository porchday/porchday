/** Small, pure validation helpers. Never include fixture values in errors. */
export class HostedIOSError extends Error {}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new HostedIOSError(code);
}
export interface HostedNativeFixture {
  v: 1; synthetic: true; origin: "https://staging.porchday.com";
  run: string; expiresAt: string; email: string; password: string; memberId: string; recoverySecret: string;
  webPostId: string; webMediaId: string; expectedPostText: string; expectedMediaSHA256: string;
  nativePostId: string; nativeMediaId: string; nativeText: string;
}
export function readHostedFixture(encoded: string, now = Date.now()): HostedNativeFixture {
  check(typeof encoded === "string" && encoded.length > 0 && encoded.length <= 16_384, "FIXTURE_SIZE");
  const bytes = Buffer.from(encoded, "base64");
  check(bytes.length <= 12_288 && bytes.toString("base64") === encoded, "FIXTURE_ENCODING");
  let value: HostedNativeFixture;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new HostedIOSError("FIXTURE_JSON"); }
  check(value && value.v === 1 && value.synthetic === true && value.origin === "https://staging.porchday.com", "FIXTURE_TARGET");
  const keys: (keyof HostedNativeFixture)[] = ["run", "expiresAt", "email", "password", "memberId", "recoverySecret", "webPostId", "webMediaId", "expectedPostText", "expectedMediaSHA256", "nativePostId", "nativeMediaId", "nativeText"];
  check(keys.every(key => typeof value[key] === "string"), "FIXTURE_FIELDS");
  check(/^[a-f0-9]{10}$/.test(value.run) && value.expectedPostText === "Synthetic web-to-native interoperability " + value.run && value.nativeText === "Synthetic native-to-web interoperability " + value.run, "FIXTURE_SYNTHETIC");
  const ids = [value.memberId, value.webPostId, value.webMediaId, value.nativePostId, value.nativeMediaId];
  check(ids.every(id => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) && new Set(ids).size === ids.length, "FIXTURE_IDS");
  check(value.email.length <= 254 && value.email.includes("@") && value.password.length >= 12 && value.password.length <= 128 && /^[A-Za-z0-9_-]{43}$/.test(value.recoverySecret), "FIXTURE_CREDENTIALS");
  check(/^[a-f0-9]{64}$/.test(value.expectedMediaSHA256), "FIXTURE_CHECKSUM");
  const expiry = Date.parse(value.expiresAt);
  check(Number.isFinite(expiry) && new Date(expiry).toISOString() === value.expiresAt && expiry > now + 300_000 && expiry <= now + 7_260_000, "FIXTURE_EXPIRED");
  return value;
}

type Tree = Record<string, any>;
/** Modify the generated test manifest, never the app's compiled configuration. */
export function configureHostedTestRun(input: Tree, encoded: string): Tree {
  const result = structuredClone(input);
  let candidates: Tree[] = [];
  if (Array.isArray(result.TestConfigurations)) {
    for (const configuration of result.TestConfigurations) {
      check(Array.isArray(configuration.TestTargets), "XCTESTRUN_TARGETS");
      for (const target of configuration.TestTargets) {
        if (target.BlueprintName === "PorchdayTests") candidates.push(target);
      }
    }
  } else if (result.PorchdayTests && typeof result.PorchdayTests === "object") candidates = [result.PorchdayTests];
  check(candidates.length === 1, "XCTESTRUN_TARGETS");
  const target = candidates[0];
  target.EnvironmentVariables = {
    ...(target.EnvironmentVariables ?? {}),
    PORCHDAY_HOSTED_STAGING_TEST: "1",
    PORCHDAY_HOSTED_FIXTURE_B64: encoded,
  };
  target.OnlyTestIdentifiers = ["HostedInteropTests/testHostedInteroperability"];
  delete target.SkipTestIdentifiers;
  return result;
}

/** Require a real successful method result; a skipped opt-in test is not proof. */
export function verifyNativeTestResult(root: Tree, testTrees: Tree[]): void {
  const value = (node: any) => node?._value;
  check(Number(value(root.metrics?.testsCount)) === 1 && Number(value(root.metrics?.testsFailedCount) ?? "0") === 0 && Number(value(root.metrics?.testsSkippedCount) ?? "0") === 0, "NATIVE_TEST_COUNTS");
  const methods: Tree[] = [];
  let visited = 0;
  function visit(node: any): void {
    check(++visited <= 100_000, "NATIVE_RESULT_BOUNDS");
    if (!node || typeof node !== "object") return;
    if (typeof value(node.identifier) === "string" && /(?:^|\/)testHostedInteroperability(?:\(\))?$/.test(value(node.identifier)) && node.testStatus) methods.push(node);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) for (const item of child) visit(item);
      else if (child && typeof child === "object") visit(child);
    }
  }
  for (const tree of testTrees) visit(tree);
  check(methods.length === 1 && value(methods[0].testStatus) === "Success", "NATIVE_TEST_NOT_PASSED");
}

export function nativeFailureCode(logTail: string): string | null {
  const match = logTail.match(/HOSTED_INTEROP_FAILED_(FIXTURE|LOGIN|RECOVERY|WEB_POST|WEB_MEDIA|NATIVE_MEDIA|NATIVE_POST|VERIFY_NATIVE_POST|LOGOUT)\b/);
  return match?.[0] ?? null;
}
