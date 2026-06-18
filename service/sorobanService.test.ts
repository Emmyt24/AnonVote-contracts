import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockRpc,
  resetMockRpc,
  simulationSuccess,
  simulationError,
  txSuccess,
  txNotFound,
  txFailed,
} from "./test-helpers/mockStellarSdk";

vi.mock("stellar-sdk", async () => {
  const { createStellarSdkMock } = await import("./test-helpers/mockStellarSdk");
  return createStellarSdkMock();
});

// Imported after vi.mock so sorobanService picks up the mocked stellar-sdk.
import {
  invokeContract,
  readContract,
  validateSorobanConfig,
  validateContractId,
  SorobanErrorCode,
  DEFAULT_RETRY_POLICY,
  type SorobanConfig,
} from "./sorobanService";

const VALID_SECRET_KEY = "S" + "B".repeat(55);
const VALID_CONTRACT_ID = "C" + "D".repeat(55);

function makeConfig(overrides: Partial<SorobanConfig> = {}): SorobanConfig {
  return {
    stellarSecretKey: VALID_SECRET_KEY,
    stellarNetwork: "testnet",
    contractId: VALID_CONTRACT_ID,
    ...overrides,
  };
}

beforeEach(() => {
  resetMockRpc();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateSorobanConfig / validateContractId", () => {
  it("rejects an invalid secret key format", () => {
    const result = validateSorobanConfig(makeConfig({ stellarSecretKey: "not-a-real-key" }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.field).toBe("stellarSecretKey");
    }
  });

  it("rejects an invalid contract ID format", () => {
    const result = validateSorobanConfig(makeConfig({ contractId: "not-a-real-contract" }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.field).toBe("contractId");
    }
  });

  it("accepts a well-formed config", () => {
    expect(validateSorobanConfig(makeConfig())).toEqual({ valid: true });
  });

  it("validateContractId allows checking the contract ID alone (no secret key required)", () => {
    expect(validateContractId(VALID_CONTRACT_ID)).toEqual({ valid: true });
    expect(validateContractId("bogus").valid).toBe(false);
  });
});

describe("invokeContract — mocked RPC", () => {
  it("returns success and a txHash when simulation + send + confirmation all succeed", async () => {
    mockRpc.simulateTransaction.mockResolvedValueOnce(simulationSuccess());
    mockRpc.sendTransaction.mockResolvedValueOnce({ status: "PENDING", hash: "tx-abc" });
    mockRpc.getTransaction.mockResolvedValueOnce(txSuccess());

    const result = await invokeContract(makeConfig(), "record_ballot", [
      { value: "GADMIN", type: "address" },
      { value: "hash1", type: "string" },
    ]);

    expect(result.success).toBe(true);
    expect(result.txHash).toBe("tx-abc");
  });

  it("returns a typed error when simulation fails with a contract error code", async () => {
    mockRpc.simulateTransaction.mockResolvedValueOnce(simulationError("Error(Contract, #4)"));

    const result = await invokeContract(makeConfig(), "record_token", [
      { value: "GADMIN", type: "address" },
      { value: "missing-ballot", type: "string" },
    ]);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(SorobanErrorCode.BallotNotFound);
    // sendTransaction should never be reached once simulation fails
    expect(mockRpc.sendTransaction).not.toHaveBeenCalled();
  });

  it("falls back to NotConfigured without throwing when the secret key is malformed", async () => {
    const result = await invokeContract(
      makeConfig({ stellarSecretKey: "bad-secret" }),
      "record_ballot",
      [{ value: "GADMIN", type: "address" }],
    );
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(SorobanErrorCode.NotConfigured);
    expect(mockRpc.simulateTransaction).not.toHaveBeenCalled();
  });
});

describe("readContract — mocked RPC", () => {
  it("returns the parsed value on a successful simulation", async () => {
    mockRpc.simulateTransaction.mockResolvedValueOnce(simulationSuccess(42));

    const { value } = await readContract(makeConfig(), "get_tokens_issued", [
      { value: "hash1", type: "string" },
    ]);
    expect(value).toBe(42);
  });

  it("guards against a successful simulation with no result/retval instead of crashing", async () => {
    // simulation reports success but `result` itself is undefined — this is
    // exactly the malformed-response shape the issue calls out (line 197).
    mockRpc.simulateTransaction.mockResolvedValueOnce(simulationSuccess(undefined));

    const { value, errorCode } = await readContract(makeConfig(), "get_tokens_issued", [
      { value: "hash1", type: "string" },
    ]);
    expect(value).toBeNull();
    expect(errorCode).toBeUndefined();
  });
});

describe("invokeContract — exponential backoff polling", () => {
  it("applies the configured backoff multiplier to successive retry delays", async () => {
    mockRpc.simulateTransaction.mockResolvedValueOnce(simulationSuccess());
    mockRpc.sendTransaction.mockResolvedValueOnce({ status: "PENDING", hash: "tx-backoff" });
    mockRpc.getTransaction
      .mockResolvedValueOnce(txNotFound())
      .mockResolvedValueOnce(txNotFound())
      .mockResolvedValueOnce(txNotFound())
      .mockResolvedValueOnce(txSuccess());

    const delays: number[] = [];
    const realSetTimeout = global.setTimeout;
    vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, 0); // fire immediately so the test stays fast
    }) as typeof setTimeout);

    const result = await invokeContract(
      makeConfig({ retryPolicy: { maxAttempts: 5, initialDelayMs: 100, backoffMultiplier: 1.5 } }),
      "record_ballot",
      [{ value: "GADMIN", type: "address" }],
    );

    expect(result.success).toBe(true);
    expect(delays).toEqual([100, 150, 225]);
  });

  it("stops after maxAttempts and returns TransactionFailed if the tx is never confirmed", async () => {
    mockRpc.simulateTransaction.mockResolvedValueOnce(simulationSuccess());
    mockRpc.sendTransaction.mockResolvedValueOnce({ status: "PENDING", hash: "tx-stuck" });
    mockRpc.getTransaction.mockResolvedValue(txNotFound());

    const realSetTimeout = global.setTimeout;
    vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => realSetTimeout(fn, 0)) as typeof setTimeout);

    const result = await invokeContract(
      makeConfig({ retryPolicy: { maxAttempts: 3, initialDelayMs: 10, backoffMultiplier: 2 } }),
      "record_ballot",
      [{ value: "GADMIN", type: "address" }],
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(SorobanErrorCode.TransactionFailed);
    // initial getTransaction call + 3 retries = 4 calls
    expect(mockRpc.getTransaction).toHaveBeenCalledTimes(4);
  });

  it("the default retry policy is 10 attempts / 1500ms initial delay / 1.5x backoff", () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({
      maxAttempts: 10,
      initialDelayMs: 1500,
      backoffMultiplier: 1.5,
    });
  });
});