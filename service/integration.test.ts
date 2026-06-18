import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockRpc, resetMockRpc, simulationError, simulationSuccess, txSuccess } from "./test-helpers/mockStellarSdk";
import { FakeLedger } from "./test-helpers/fakeLedger";

vi.mock("stellar-sdk", async () => {
  const { createStellarSdkMock } = await import("./test-helpers/mockStellarSdk");
  return createStellarSdkMock();
});

import {
  sorobanRecordBallot,
  sorobanRecordToken,
  sorobanRecordVote,
  sorobanRecordResult,
  sorobanGetAuditCounts,
  sorobanResultExists,
  SorobanErrorCode,
  type SorobanConfig,
} from "./sorobanService";

const ADMIN_SECRET_KEY = "S" + "B".repeat(55);
const OTHER_ADMIN_SECRET_KEY = "S" + "C".repeat(55);
const CONTRACT_ID = "C" + "D".repeat(55);

function makeConfig(secretKey = ADMIN_SECRET_KEY): SorobanConfig {
  return { stellarSecretKey: secretKey, stellarNetwork: "testnet", contractId: CONTRACT_ID };
}

let ledger: FakeLedger;

beforeEach(() => {
  resetMockRpc();
  ledger = new FakeLedger();

  // Wire the fake RPC to the in-memory ledger: every invokeContract/readContract
  // call ends up here as a single operation on the built transaction.
  mockRpc.simulateTransaction.mockImplementation(async (tx: any) => {
    const op = tx.operations[0];
    const outcome = ledger.call(op.method, op.args);
    if (!outcome.ok) {
      return simulationError(`Error(Contract, #${outcome.contractErrorCode})`);
    }
    (mockRpc as any)._lastValue = outcome.value;
    return simulationSuccess(outcome.value);
  });
  mockRpc.sendTransaction.mockImplementation(async () => ({
    status: "PENDING",
    hash: "tx-" + Math.random().toString(36).slice(2),
  }));
  mockRpc.getTransaction.mockImplementation(async () => txSuccess((mockRpc as any)._lastValue));
});

describe("AnonVote ballot lifecycle (mocked contract, no live network)", () => {
  it("runs create -> tokens -> votes -> result and reflects correct audit counts throughout", async () => {
    const config = makeConfig();
    const ballotIdHash = "ballot-hash-001";

    const ballotResult = await sorobanRecordBallot(config, ballotIdHash);
    expect(ballotResult.success).toBe(true);

    await sorobanRecordToken(config, ballotIdHash);
    await sorobanRecordToken(config, ballotIdHash);
    const tokenResult = await sorobanRecordToken(config, ballotIdHash);
    expect(tokenResult.success).toBe(true);

    let counts = await sorobanGetAuditCounts(config, ballotIdHash);
    expect(counts).toEqual({ tokensIssued: 3, votesCast: 0, isConsistent: false });

    await sorobanRecordVote(config, ballotIdHash);
    await sorobanRecordVote(config, ballotIdHash);
    const voteResult = await sorobanRecordVote(config, ballotIdHash);
    expect(voteResult.success).toBe(true);

    counts = await sorobanGetAuditCounts(config, ballotIdHash);
    expect(counts).toEqual({ tokensIssued: 3, votesCast: 3, isConsistent: true });

    const resultResult = await sorobanRecordResult(config, ballotIdHash, "result-hash-aaa");
    expect(resultResult.success).toBe(true);
  });

  it("treats re-recording the same result hash as an idempotent success", async () => {
    // Per lib.rs, record_result returns Ok(()) directly when the same hash is
    // re-recorded (it never raises ResultAlreadyPublished for a matching
    // hash), so this resolves through the normal success path with a real
    // txHash — not through sorobanRecordResult's defensive
    // ResultAlreadyPublished-recovery branch, which only triggers when the
    // on-chain hash genuinely differs from a *different* candidate hash.
    const config = makeConfig();
    const ballotIdHash = "ballot-hash-002";

    await sorobanRecordBallot(config, ballotIdHash);
    await sorobanRecordResult(config, ballotIdHash, "result-hash-bbb");
    const secondCall = await sorobanRecordResult(config, ballotIdHash, "result-hash-bbb");

    expect(secondCall.success).toBe(true);
  });

  it("rejects a conflicting result hash with ResultAlreadyPublished", async () => {
    const config = makeConfig();
    const ballotIdHash = "ballot-hash-003";

    await sorobanRecordBallot(config, ballotIdHash);
    await sorobanRecordResult(config, ballotIdHash, "result-hash-ccc");
    const conflicting = await sorobanRecordResult(config, ballotIdHash, "result-hash-DIFFERENT");

    expect(conflicting.success).toBe(false);
    expect(conflicting.errorCode).toBe(SorobanErrorCode.ResultAlreadyPublished);
  });

  it("returns BallotNotFound when recording a token against a ballot that was never created", async () => {
    const config = makeConfig();
    const result = await sorobanRecordToken(config, "never-created");
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(SorobanErrorCode.BallotNotFound);
  });

  it("treats re-recording the same ballot by the same admin as idempotent, but a different admin as a conflict", async () => {
    const ballotIdHash = "ballot-hash-004";
    const adminConfig = makeConfig(ADMIN_SECRET_KEY);
    const otherAdminConfig = makeConfig(OTHER_ADMIN_SECRET_KEY);

    const first = await sorobanRecordBallot(adminConfig, ballotIdHash);
    expect(first.success).toBe(true);

    const sameAdminAgain = await sorobanRecordBallot(adminConfig, ballotIdHash);
    expect(sameAdminAgain.success).toBe(true);

    const differentAdmin = await sorobanRecordBallot(otherAdminConfig, ballotIdHash);
    expect(differentAdmin.success).toBe(false);
    expect(differentAdmin.errorCode).toBe(SorobanErrorCode.BallotAlreadyExists);
  });

  it("every helper returns NotConfigured rather than throwing when config validation fails", async () => {
    const badConfig = makeConfig("not-a-real-secret-key");
    const ballotIdHash = "ballot-hash-005";

    const results = await Promise.all([
      sorobanRecordBallot(badConfig, ballotIdHash),
      sorobanRecordToken(badConfig, ballotIdHash),
      sorobanRecordVote(badConfig, ballotIdHash),
      sorobanRecordResult(badConfig, ballotIdHash, "x"),
    ]);

    for (const r of results) {
      expect(r.success).toBe(false);
      expect(r.errorCode).toBe(SorobanErrorCode.NotConfigured);
    }
    expect(mockRpc.simulateTransaction).not.toHaveBeenCalled();
  });

  it("TypeScript enforces error-field access only on the failure branch (compile-time check)", async () => {
    const config = makeConfig();
    const result = await sorobanRecordToken(config, "never-created-either");

    if (!result.success) {
      // Only reachable (and only type-checks) when success is narrowed to false.
      expect(result.errorCode).toBe(SorobanErrorCode.BallotNotFound);
    } else {
      expect(result.txHash).toBeTypeOf("string");
    }
  });

  it("sorobanResultExists returns false before publication and true after", async () => {
    const config = makeConfig();
    const ballotIdHash = "ballot-hash-006";

    await sorobanRecordBallot(config, ballotIdHash);

    const beforeResult = await sorobanResultExists(config, ballotIdHash);
    expect(beforeResult).toBe(false);

    await sorobanRecordResult(config, ballotIdHash, "result-hash-ddd");

    const afterResult = await sorobanResultExists(config, ballotIdHash);
    expect(afterResult).toBe(true);
  });
});