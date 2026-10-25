import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readHostedFixture, hostedTestIdentifier, socialTestIdentifier, configureHostedTestRun, verifyNativeTestResult, nativeFailureCode, nativeFailureDiagnostic } from "./hosted-ios-support.ts";

const now = Date.parse("2026-01-01T10:00:00.000Z");
const fixture = {
  v: 1, synthetic: true, origin: "https://staging.porchday.com", run: "aabbcc0011",
  expiresAt: "2026-01-01T12:00:00.000Z", email: "fictional@example.invalid", password: "synthetic-fixture-password",
  memberId: "11111111-1111-4111-8111-111111111111", recoverySecret: "A".repeat(43),
  webPostId: "22222222-2222-4222-8222-222222222222", webMediaId: "33333333-3333-4333-8333-333333333333",
  nativePostId: "44444444-4444-4444-8444-444444444444", nativeMediaId: "55555555-5555-4555-8555-555555555555",
  expectedPostText: "Synthetic web-to-native interoperability aabbcc0011", expectedMediaSHA256: "a".repeat(64),
  nativeText: "Synthetic native-to-web interoperability aabbcc0011",
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
describe("opt-in hosted iOS test controls", () => {
  it("requires a short-lived synthetic fixture targeting only the staging origin", () => {
    expect(readHostedFixture(encode(fixture), now).memberId).toBe(fixture.memberId);
    for (const changed of [
      { ...fixture, origin: "https://porchday.com" },
      { ...fixture, origin: "https://staging.porchday.com.evil.example" },
      { ...fixture, synthetic: false }, { ...fixture, nativeText: "Not synthetic" },
      { ...fixture, expiresAt: "2026-01-01T10:01:00.000Z" },
      { ...fixture, expiresAt: "2026-01-02T10:00:00.000Z" },
      { ...fixture, nativeMediaId: fixture.webMediaId },
      { ...fixture, expectedMediaSHA256: "bad" },
    ]) expect(() => readHostedFixture(encode(changed), now)).toThrow(/^FIXTURE_/);
    expect(() => readHostedFixture("not base64", now)).toThrow("FIXTURE_ENCODING");
  });
  it("never quotes rejected private input in validation errors", () => {
    const sensitive = "do-not-echo-private-payload";
    for (const encoded of [Buffer.from(sensitive).toString("base64"), encode({ ...fixture, password: sensitive, origin: sensitive })]) {
      try { readHostedFixture(encoded, now); throw new Error("Expected failure"); }
      catch (error) { expect(String(error)).not.toContain(sensitive); }
    }
  });
  it("keeps the A-only social scenario separate from expired media fixtures and validates every parent deadline", () => {
    const social = {v:2,scenario:"comments-reactions",synthetic:true,origin:fixture.origin,run:fixture.run,attempt:"aabb0011",
      expiresAt:fixture.expiresAt,email:fixture.email,password:fixture.password,memberId:fixture.memberId,recoverySecret:fixture.recoverySecret,
      webPostId:fixture.webPostId,webCommentId:fixture.webMediaId,webReplyId:fixture.nativePostId,nativeCommentId:fixture.nativeMediaId,
      nativeReplyId:"66666666-6666-4666-8666-666666666666",webCommentExpiresAt:"2026-01-01T11:50:00.000Z",webReplyExpiresAt:"2026-01-01T11:40:00.000Z"};
    expect(hostedTestIdentifier(readHostedFixture(encode(social),now))).toBe(socialTestIdentifier);
    for(const change of [{scenario:"anything"},{v:1},{attempt:"anything"},{nativeReplyId:fixture.webPostId},
      {webCommentExpiresAt:fixture.expiresAt},{webReplyExpiresAt:"2026-01-01T12:10:00.000Z"}])
      expect(()=>readHostedFixture(encode({...social,...change}),now)).toThrow(/^FIXTURE_/);
    expect(()=>readHostedFixture(encode(social),now+80*60_000)).toThrow("FIXTURE_EXPIRED");
    const manifest=configureHostedTestRun({PorchdayTests:{}},encode(social),socialTestIdentifier);
    expect(manifest.PorchdayTests.OnlyTestIdentifiers).toEqual([socialTestIdentifier]);
    const root={metrics:{testsCount:{_value:"1"},testsFailedCount:{_value:"0"},testsSkippedCount:{_value:"0"}}};
    const result={identifier:{_value:"PorchdayTests/"+socialTestIdentifier+"()"},testStatus:{_value:"Success"}};
    expect(()=>verifyNativeTestResult(root,[result],socialTestIdentifier)).not.toThrow();
    expect(()=>verifyNativeTestResult(root,[result])).toThrow("NATIVE_TEST_NOT_PASSED");
    expect(()=>verifyNativeTestResult(root,[{...result,testStatus:{_value:"Skipped"}}],socialTestIdentifier)).toThrow("NATIVE_TEST_NOT_PASSED");
  });
  it("injects credentials only into the selected unit target's private runtime manifest", () => {
    const original = { TestConfigurations: [{ TestTargets: [
      { BlueprintName: "PorchdayTests", EnvironmentVariables: { PRESERVED: "yes" }, SkipTestIdentifiers: ["anything"] },
      { BlueprintName: "PorchdayUITests", EnvironmentVariables: { UNCHANGED: "yes" } },
    ] }] };
    const encoded = encode(fixture), configured = configureHostedTestRun(original, encoded);
    const [unit, ui] = configured.TestConfigurations[0].TestTargets;
    expect(unit.EnvironmentVariables.PORCHDAY_HOSTED_STAGING_TEST).toBe("1");
    expect(unit.EnvironmentVariables.PORCHDAY_HOSTED_FIXTURE_B64).toBe(encoded);
    expect(unit.EnvironmentVariables.PRESERVED).toBe("yes");
    expect(unit.OnlyTestIdentifiers).toEqual(["HostedInteropTests/testHostedInteroperability"]);
    expect(unit).not.toHaveProperty("SkipTestIdentifiers");
    expect(ui).toEqual(original.TestConfigurations[0].TestTargets[1]);
    expect(original.TestConfigurations[0].TestTargets[0].EnvironmentVariables).not.toHaveProperty("PORCHDAY_HOSTED_FIXTURE_B64");
    expect(() => configureHostedTestRun({ TestConfigurations: [] }, encoded)).toThrow("XCTESTRUN_TARGETS");
    const legacy = configureHostedTestRun({ PorchdayTests: { TestBundlePath: "__TESTROOT__/Tests.xctest" } }, encoded);
    expect(legacy.PorchdayTests.EnvironmentVariables.PORCHDAY_HOSTED_STAGING_TEST).toBe("1");
  });
  it("requires one real successful native test and refuses a skipped opt-in test", () => {
    const root = { metrics: { testsCount: { _value: "1" }, testsFailedCount: { _value: "0" }, testsSkippedCount: { _value: "0" } } };
    const method = { identifier: { _value: "HostedInteropTests/testHostedInteroperability()" }, testStatus: { _value: "Success" } };
    expect(() => verifyNativeTestResult(root, [{ tests: { _values: [method] } }])).not.toThrow();
    expect(() => verifyNativeTestResult(root, [])).toThrow("NATIVE_TEST_NOT_PASSED");
    expect(() => verifyNativeTestResult(root, [method, method])).toThrow("NATIVE_TEST_NOT_PASSED");
    expect(() => verifyNativeTestResult(root, [{ ...method, testStatus: { _value: "Skipped" } }])).toThrow("NATIVE_TEST_NOT_PASSED");
    expect(() => verifyNativeTestResult({ metrics: { testsCount: { _value: "0" } } }, [method])).toThrow("NATIVE_TEST_COUNTS");
    expect(() => verifyNativeTestResult({ metrics: { ...root.metrics, testsSkippedCount: { _value: "1" } } }, [method])).toThrow("NATIVE_TEST_COUNTS");
  });
  it("extracts only a closed failure phase, never test log contents", () => {
    expect(nativeFailureCode("private details\nHOSTED_INTEROP_FAILED_RECOVERY\nmore private details")).toBe("HOSTED_INTEROP_FAILED_RECOVERY");
    expect(nativeFailureCode("HOSTED_INTEROP_FAILED_some_private_string")).toBeNull();
    expect(nativeFailureDiagnostic("private details HOSTED_INTEROP_DIAGNOSTIC_KEYCHAIN_WRITE more private details")).toBe("KEYCHAIN_WRITE");
    expect(nativeFailureDiagnostic("HOSTED_INTEROP_DIAGNOSTIC_private_payload")).toBeNull();
    expect(nativeFailureDiagnostic("HOSTED_INTEROP_DIAGNOSTIC_OTHER_PRIVATE_PAYLOAD")).toBeNull();
  });
  it("refuses an ordinary local execution with fixed output and no fixture disclosure", () => {
    const secretMarker = "never-print-this-synthetic-secret";
    const result = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("run-hosted-ios.ts", import.meta.url)), "--run"], {
      encoding: "utf8", timeout: 10_000,
      env: { ...process.env, GITHUB_ACTIONS: "false", PORCHDAY_IOS_HOSTED_FIXTURE_B64: secretMarker },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({ step: "hosted-native", result: "failed", phase: "PREFLIGHT", code: "EPHEMERAL_MACOS_RUNNER_REQUIRED", cleanup: true });
    expect(result.stdout + result.stderr).not.toContain(secretMarker);
  });
});
