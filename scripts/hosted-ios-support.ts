/** Small, pure validation helpers. Never include fixture values in errors. */
export class HostedIOSError extends Error {}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new HostedIOSError(code);
}
interface HostedFixtureIdentity {
  synthetic: true; origin: "https://staging.porchday.com";
  run: string; expiresAt: string; email: string; password: string; memberId: string; recoverySecret: string;
}
export interface HostedMediaFixture extends HostedFixtureIdentity {
  v: 1;
  webPostId: string; webMediaId: string; expectedPostText: string; expectedMediaSHA256: string;
  nativePostId: string; nativeMediaId: string; nativeText: string;
}
export interface HostedSocialFixture extends HostedFixtureIdentity {
  v: 2; scenario: "comments-reactions"; attempt: string;
  webPostId: string; webCommentId: string; webReplyId: string;
  nativeCommentId: string; nativeReplyId: string;
  webCommentExpiresAt: string; webReplyExpiresAt: string;
}
export type HostedNativeFixture = HostedMediaFixture | HostedSocialFixture;
export const mediaTestIdentifier = "HostedInteropTests/testHostedInteroperability";
export const socialTestIdentifier = "HostedSocialInteropTests/testHostedCommentsAndReactions";
export type HostedTestIdentifier = typeof mediaTestIdentifier | typeof socialTestIdentifier;
export function hostedTestIdentifier(fixture: HostedNativeFixture): HostedTestIdentifier {
  return fixture.v === 2 ? socialTestIdentifier : mediaTestIdentifier;
}
export function socialFixtureText(fixture: Pick<HostedSocialFixture, "run" | "attempt">, kind: "post" | "web-comment" | "web-reply" | "native-comment" | "native-reply") {
  return `Synthetic native social ${fixture.run}/${fixture.attempt} ${kind}`;
}
export function readHostedFixture(encoded: string, now = Date.now()): HostedNativeFixture {
  check(typeof encoded === "string" && encoded.length > 0 && encoded.length <= 16_384, "FIXTURE_SIZE");
  const bytes = Buffer.from(encoded, "base64");
  check(bytes.length <= 12_288 && bytes.toString("base64") === encoded, "FIXTURE_ENCODING");
  let value: HostedNativeFixture;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new HostedIOSError("FIXTURE_JSON"); }
  check(value && (value.v === 1 || value.v === 2 && value.scenario === "comments-reactions") && value.synthetic === true && value.origin === "https://staging.porchday.com", "FIXTURE_TARGET");
  const keys: (keyof HostedFixtureIdentity)[] = ["run", "expiresAt", "email", "password", "memberId", "recoverySecret"];
  check(keys.every(key => typeof value[key] === "string"), "FIXTURE_FIELDS");
  check(/^[a-f0-9]{10}$/.test(value.run), "FIXTURE_SYNTHETIC");
  check(value.email.length <= 254 && value.email.includes("@") && value.password.length >= 12 && value.password.length <= 128 && /^[A-Za-z0-9_-]{43}$/.test(value.recoverySecret), "FIXTURE_CREDENTIALS");
  const expiry = Date.parse(value.expiresAt);
  check(Number.isFinite(expiry) && new Date(expiry).toISOString() === value.expiresAt && expiry > now + 300_000 && expiry <= now + 7_260_000, "FIXTURE_EXPIRED");
  let ids: string[];
  if (value.v === 1) {
    check(value.expectedPostText === "Synthetic web-to-native interoperability " + value.run && value.nativeText === "Synthetic native-to-web interoperability " + value.run, "FIXTURE_SYNTHETIC");
    check(typeof value.expectedMediaSHA256 === "string" && /^[a-f0-9]{64}$/.test(value.expectedMediaSHA256), "FIXTURE_CHECKSUM");
    ids = [value.memberId, value.webPostId, value.webMediaId, value.nativePostId, value.nativeMediaId];
  } else {
    check(typeof value.attempt === "string" && /^[a-f0-9]{8}$/.test(value.attempt), "FIXTURE_SYNTHETIC");
    check(expiry > now + 45 * 60_000, "FIXTURE_EXPIRED");
    for (const [deadline, delta] of [[value.webCommentExpiresAt, 600_000], [value.webReplyExpiresAt, 1_200_000]] as const)
      check(typeof deadline === "string" && Date.parse(deadline) === expiry - delta && new Date(expiry - delta).toISOString() === deadline, "FIXTURE_DEADLINES");
    ids = [value.memberId, value.webPostId, value.webCommentId, value.webReplyId, value.nativeCommentId, value.nativeReplyId];
  }
  check(ids.every(id => typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) && new Set(ids).size === ids.length, "FIXTURE_IDS");
  return value;
}

type Tree = Record<string, any>;
/** Modify the generated test manifest, never the app's compiled configuration. */
export function configureHostedTestRun(input: Tree, encoded: string, identifier: HostedTestIdentifier = mediaTestIdentifier): Tree {
  check([mediaTestIdentifier, socialTestIdentifier].includes(identifier), "XCTESTRUN_IDENTIFIER");
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
  target.OnlyTestIdentifiers = [identifier];
  delete target.SkipTestIdentifiers;
  return result;
}

/** Require a real successful method result; a skipped opt-in test is not proof. */
export function verifyNativeTestResult(root: Tree, testTrees: Tree[], identifier: HostedTestIdentifier = mediaTestIdentifier): void {
  check([mediaTestIdentifier, socialTestIdentifier].includes(identifier), "XCTESTRUN_IDENTIFIER");
  const value = (node: any) => node?._value;
  check(Number(value(root.metrics?.testsCount)) === 1 && Number(value(root.metrics?.testsFailedCount) ?? "0") === 0 && Number(value(root.metrics?.testsSkippedCount) ?? "0") === 0, "NATIVE_TEST_COUNTS");
  const methods: Tree[] = [];
  let visited = 0;
  function visit(node: any): void {
    check(++visited <= 100_000, "NATIVE_RESULT_BOUNDS");
    if (!node || typeof node !== "object") return;
    const method = value(node.identifier);
    const normalized = typeof method === "string" ? method.replace(/\(\)$/, "") : "";
    if ((normalized === identifier || normalized.endsWith("/" + identifier) || normalized === identifier.split("/")[1]) && node.testStatus) methods.push(node);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) for (const item of child) visit(item);
      else if (child && typeof child === "object") visit(child);
    }
  }
  for (const tree of testTrees) visit(tree);
  check(methods.length === 1 && value(methods[0].testStatus) === "Success", "NATIVE_TEST_NOT_PASSED");
}

export function nativeFailureCode(logTail: string): string | null {
  const match = logTail.match(/HOSTED_INTEROP_FAILED_(FIXTURE|LOGIN|RECOVERY|WEB_POST|WEB_MEDIA|NATIVE_MEDIA|NATIVE_POST|VERIFY_NATIVE_POST|WEB_COMMENTS|WEB_REACTIONS|NATIVE_COMMENTS|NATIVE_REACTIONS|VERIFY_NATIVE_SOCIAL|DEVICE_CLEANUP|LOGOUT)\b/);
  return match?.[0] ?? null;
}

export function nativeFailureDiagnostic(logTail: string): string | null {
  const match = logTail.match(/HOSTED_INTEROP_DIAGNOSTIC_(KEYCHAIN_WRITE|KEYCHAIN_READ|MEMBER_SHAPE|DEVICE_SHAPE|ORIGIN|CLIENT_OTHER|UNAUTHORIZED|RATE_LIMIT|CREDENTIALS|EMAIL_UNVERIFIED|API_OTHER|DECODING|NETWORK_TIMEOUT|NETWORK_TLS|NETWORK_OTHER|STATE_MISMATCH|OTHER)\b/);
  return match?.[1] ?? null;
}
