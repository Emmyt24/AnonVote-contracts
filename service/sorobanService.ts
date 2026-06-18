/**
 * AnonVote Soroban Service
 *
 * TypeScript service for invoking the AnonVote Soroban smart contract from
 * the AnonVote/core backend.
 *
 * STATUS: Contract written (contracts/anonvote/src/lib.rs) — needs deployment.
 * The manageData-based stellarService is the active blockchain layer.
 * This service is ready to wire once the Soroban contract is deployed.
 *
 * TO ACTIVATE:
 * 1. Build the contract:
 *      cd contracts/anonvote && cargo build --target wasm32-unknown-unknown --release
 * 2. Deploy to testnet:
 *      stellar contract deploy --wasm target/wasm32-unknown-unknown/release/anonvote.wasm --network testnet
 * 3. Initialize:
 *      stellar contract invoke --id <CONTRACT_ID> --network testnet -- initialize --admin <PUBLIC_KEY>
 * 4. Set SOROBAN_CONTRACT_ID=<CONTRACT_ID> in backend/.env
 * 5. Call the helpers below from ballotEngine, identityManager, privacyEngine, resultEngine
 */

import * as StellarSdk from "stellar-sdk";

const SOROBAN_RPC_TESTNET = "https://soroban-testnet.stellar.org";
const SOROBAN_RPC_MAINNET = "https://rpc.stellar.org";

// ── Error codes matching ContractError enum in lib.rs ─────────────────────────

export enum SorobanErrorCode {
  AdminUnauthorized      = 1,
  AlreadyInitialized     = 2,
  NotInitialized         = 3,
  BallotNotFound         = 4,
  BallotAlreadyExists    = 5,
  ResultAlreadyPublished = 6,
  CounterOverflow        = 7,
  InvalidBallotHash      = 8,
  // Non-contract errors
  SimulationFailed       = 100,
  TransactionFailed      = 101,
  NetworkError           = 102,
  NotConfigured          = 103,
}

const ERROR_MESSAGES: Record<SorobanErrorCode, string> = {
  [SorobanErrorCode.AdminUnauthorized]:      "Caller is not the contract admin",
  [SorobanErrorCode.AlreadyInitialized]:     "Contract already initialized",
  [SorobanErrorCode.NotInitialized]:         "Contract not initialized",
  [SorobanErrorCode.BallotNotFound]:         "Ballot does not exist on-chain",
  [SorobanErrorCode.BallotAlreadyExists]:    "Ballot already recorded by a different admin",
  [SorobanErrorCode.ResultAlreadyPublished]: "A different result hash is already published for this ballot",
  [SorobanErrorCode.CounterOverflow]:        "Counter has reached u32::MAX",
  [SorobanErrorCode.InvalidBallotHash]:      "Ballot hash must not be empty",
  [SorobanErrorCode.SimulationFailed]:       "Transaction simulation failed",
  [SorobanErrorCode.TransactionFailed]:      "Transaction submission failed",
  [SorobanErrorCode.NetworkError]:           "Network or RPC error",
  [SorobanErrorCode.NotConfigured]:          "Contract ID or secret key not configured",
};

// ── Public interfaces ─────────────────────────────────────────────────────────

/**
 * Retry/backoff policy for the transaction-confirmation polling loop in
 * invokeContract. Defaults match Stellar's ~5-6s block time closely enough
 * for quick polls while still backing off under load (see DEFAULT_RETRY_POLICY).
 */
export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  backoffMultiplier: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 10,
  initialDelayMs: 1500,
  backoffMultiplier: 1.5,
};

export interface SorobanConfig {
  stellarSecretKey: string;
  stellarNetwork: "testnet" | "mainnet";
  contractId: string;
  /** Optional override for the transaction-confirmation retry/backoff strategy. */
  retryPolicy?: RetryPolicy;
}

export enum BallotState {
  Active          = "Active",
  ResultPublished = "ResultPublished",
}

export interface BallotStateSnapshot {
  tokens_issued: number;
  votes_cast: number;
  result_hash: string | null;
  created_at: number;
  admin: string;
  state: BallotState;
}

export interface SorobanInvokeResult {
  txHash: string;
  success: boolean;
  returnValue?: unknown;
  errorCode?: SorobanErrorCode;
  errorMessage?: string;
}

// ── Config validation ──────────────────────────────────────────────────────

export interface ConfigError {
  field: "stellarSecretKey" | "contractId";
  message: string;
}

export type ConfigValidationResult =
  | { valid: true }
  | { valid: false; error: ConfigError };

/**
 * Validate that a contract ID is a well-formed Soroban contract address.
 * Exposed separately from validateSorobanConfig because readContract is
 * allowed to run without a secret key (it falls back to a throwaway keypair
 * for the simulation-only source account), so it only needs this check.
 */
export function validateContractId(contractId: string): ConfigValidationResult {
  if (!contractId || !StellarSdk.StrKey.isValidContract(contractId)) {
    return {
      valid: false,
      error: {
        field: "contractId",
        message: "contractId must be a valid Soroban contract address (starts with 'C')",
      },
    };
  }
  return { valid: true };
}

/**
 * Validate that a SorobanConfig has a well-formed secret key and contract ID
 * before any RPC call is attempted. Uses stellar-sdk's StrKey checksum
 * validation (rather than a hand-rolled regex) so malformed keys are rejected
 * with a clear, typed error instead of failing later inside Keypair.fromSecret
 * or at RPC time with an opaque network error.
 */
export function validateSorobanConfig(config: SorobanConfig): ConfigValidationResult {
  if (!config.stellarSecretKey || !StellarSdk.StrKey.isValidEd25519SecretSeed(config.stellarSecretKey)) {
    return {
      valid: false,
      error: {
        field: "stellarSecretKey",
        message: "stellarSecretKey must be a valid Stellar Ed25519 secret seed (starts with 'S')",
      },
    };
  }
  return validateContractId(config.contractId);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function getRpcUrl(network: string): string {
  return network === "mainnet" ? SOROBAN_RPC_MAINNET : SOROBAN_RPC_TESTNET;
}

function getNetworkPassphrase(network: string): string {
  return network === "mainnet"
    ? StellarSdk.Networks.PUBLIC
    : StellarSdk.Networks.TESTNET;
}

function getRpcServer(network: string): StellarSdk.SorobanRpc.Server {
  return new StellarSdk.SorobanRpc.Server(getRpcUrl(network), {
    allowHttp: false,
  });
}

function makeError(code: SorobanErrorCode): Pick<SorobanInvokeResult, "errorCode" | "errorMessage"> {
  return { errorCode: code, errorMessage: ERROR_MESSAGES[code] };
}

/**
 * Parse a Soroban contract error code out of a simulation error string.
 * Contract errors are surfaced as "Error(Contract, #N)" in the XDR diagnostics.
 */
function parseContractErrorCode(errorText: string): SorobanErrorCode | undefined {
  // Soroban encodes contract errors as "Error(Contract, #<code>)"
  const match = errorText.match(/Error\(Contract,\s*#(\d+)\)/);
  if (match && match[1] !== undefined) {
    const code = parseInt(match[1], 10);
    if (code in SorobanErrorCode) return code as SorobanErrorCode;
  }
  return undefined;
}

// ── Core invoke / read ────────────────────────────────────────────────────────

/**
 * Invoke a method on the deployed AnonVote Soroban contract.
 * Parses contract error codes from simulation and surfaces them in the result.
 */
export async function invokeContract(
  config: SorobanConfig,
  method: string,
  args: { value: unknown; type: string }[],
): Promise<SorobanInvokeResult> {
  const configCheck = validateSorobanConfig(config);
  if (!configCheck.valid) {
    console.warn(`[Soroban] ${method}: invalid config — ${configCheck.error.message}`);
    return { txHash: "", success: false, ...makeError(SorobanErrorCode.NotConfigured) };
  }

  try {
    const keypair = StellarSdk.Keypair.fromSecret(config.stellarSecretKey);
    const server   = getRpcServer(config.stellarNetwork);
    const account  = await server.getAccount(keypair.publicKey());

    const scArgs   = args.map(({ value, type }) =>
      StellarSdk.nativeToScVal(value, { type: type as any }),
    );

    const contract  = new StellarSdk.Contract(config.contractId);
    const operation = contract.call(method, ...scArgs);

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: getNetworkPassphrase(config.stellarNetwork),
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simulation = await server.simulateTransaction(tx);

    if (StellarSdk.SorobanRpc.Api.isSimulationError(simulation)) {
      // Defensive: isSimulationError type-guards `.error` as present, but RPC
      // responses are not guaranteed to honor that — fall back to a generic
      // message rather than interpolating `undefined` into logs/errorMessage.
      const errorText    = simulation.error || "Unknown simulation error (no detail provided by RPC)";
      const contractCode = parseContractErrorCode(errorText);
      const code    = contractCode ?? SorobanErrorCode.SimulationFailed;
      const message = contractCode
        ? ERROR_MESSAGES[contractCode]
        : errorText;
      console.error(`[Soroban] ${method} simulation failed — code ${code}: ${message}`);
      return { txHash: "", success: false, errorCode: code, errorMessage: message };
    }

    const preparedTx = StellarSdk.SorobanRpc.assembleTransaction(
      tx,
      simulation,
    ).build();

    preparedTx.sign(keypair);
    const sendResult = await server.sendTransaction(preparedTx);

    if (sendResult.status === "ERROR") {
      console.error(`[Soroban] ${method} send failed:`, sendResult.errorResult);
      return { txHash: "", success: false, ...makeError(SorobanErrorCode.TransactionFailed) };
    }

    const txHash      = sendResult.hash;
    const retryPolicy = config.retryPolicy ?? DEFAULT_RETRY_POLICY;

    let getResult = await server.getTransaction(txHash);
    let attempts  = 0;
    let delayMs   = retryPolicy.initialDelayMs;

    while (
      getResult.status === StellarSdk.SorobanRpc.Api.GetTransactionStatus.NOT_FOUND &&
      attempts < retryPolicy.maxAttempts
    ) {
      console.log(
        `[Soroban] ${method}: tx ${txHash} not yet confirmed — retry ${attempts + 1}/${retryPolicy.maxAttempts} in ${delayMs}ms`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
      getResult = await server.getTransaction(txHash);
      attempts++;
      delayMs = Math.round(delayMs * retryPolicy.backoffMultiplier);
    }

    if (getResult.status === StellarSdk.SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      const returnValue = getResult.returnValue
        ? StellarSdk.scValToNative(getResult.returnValue)
        : undefined;
      console.log(`[Soroban] ${method} succeeded — tx: ${txHash}`);
      return { txHash, success: true, returnValue };
    }

    console.error(`[Soroban] ${method} transaction failed:`, getResult);
    return { txHash: "", success: false, ...makeError(SorobanErrorCode.TransactionFailed) };
  } catch (err) {
    console.error(`[Soroban] ${method} network error:`, err);
    return { txHash: "", success: false, ...makeError(SorobanErrorCode.NetworkError) };
  }
}

/**
 * Read contract data without submitting a transaction (view call / simulation only).
 * Returns { value, errorCode, errorMessage } so callers can distinguish "not found"
 * from "network error".
 */
export async function readContract(
  config: SorobanConfig,
  method: string,
  args: { value: unknown; type: string }[],
): Promise<{ value: unknown | null; errorCode?: SorobanErrorCode; errorMessage?: string }> {
  const contractCheck = validateContractId(config.contractId);
  if (!contractCheck.valid) {
    console.warn(`[Soroban] ${method}: invalid config — ${contractCheck.error.message}`);
    return { value: null, ...makeError(SorobanErrorCode.NotConfigured) };
  }
  if (config.stellarSecretKey && !StellarSdk.StrKey.isValidEd25519SecretSeed(config.stellarSecretKey)) {
    console.warn(`[Soroban] ${method}: invalid stellarSecretKey format`);
    return { value: null, ...makeError(SorobanErrorCode.NotConfigured) };
  }

  try {
    const keypair = config.stellarSecretKey
      ? StellarSdk.Keypair.fromSecret(config.stellarSecretKey)
      : StellarSdk.Keypair.random();

    const server  = getRpcServer(config.stellarNetwork);
    const account = await server.getAccount(keypair.publicKey());

    const scArgs  = args.map(({ value, type }) =>
      StellarSdk.nativeToScVal(value, { type: type as any }),
    );

    const contract  = new StellarSdk.Contract(config.contractId);
    const operation = contract.call(method, ...scArgs);

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: getNetworkPassphrase(config.stellarNetwork),
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simulation = await server.simulateTransaction(tx);

    if (StellarSdk.SorobanRpc.Api.isSimulationError(simulation)) {
      const errorText     = simulation.error || "Unknown simulation error (no detail provided by RPC)";
      const contractCode  = parseContractErrorCode(errorText);
      const code    = contractCode ?? SorobanErrorCode.SimulationFailed;
      const message = contractCode ? ERROR_MESSAGES[contractCode] : errorText;
      console.error(`[Soroban] ${method} read failed — code ${code}: ${message}`);
      return { value: null, errorCode: code, errorMessage: message };
    }

    if (
      StellarSdk.SorobanRpc.Api.isSimulationSuccess(simulation) &&
      simulation.result?.retval
    ) {
      return { value: StellarSdk.scValToNative(simulation.result.retval) };
    }

    return { value: null };
  } catch (err) {
    console.error(`[Soroban] ${method} read error:`, err);
    return { value: null, ...makeError(SorobanErrorCode.NetworkError) };
  }
}

// ── AnonVote contract helpers ─────────────────────────────────────────────────

/**
 * Record a ballot creation on-chain.
 * Idempotent: if the same ballot was already recorded by this admin, the
 * contract returns success without a state change.
 *
 * Returns the full SorobanInvokeResult (not just txHash) so callers can
 * distinguish "not configured" from "ballot already exists under a
 * different admin" from "network error" — see SorobanErrorCode.
 */
export async function sorobanRecordBallot(
  config: SorobanConfig,
  ballotIdHash: string,
): Promise<SorobanInvokeResult> {
  const configCheck = validateSorobanConfig(config);
  if (!configCheck.valid) {
    console.warn(`[Soroban] sorobanRecordBallot: ${configCheck.error.message}`);
    return { txHash: "", success: false, ...makeError(SorobanErrorCode.NotConfigured) };
  }
  const caller = StellarSdk.Keypair.fromSecret(config.stellarSecretKey).publicKey();
  const result = await invokeContract(config, "record_ballot", [
    { value: caller, type: "address" },
    { value: ballotIdHash, type: "string" },
  ]);
  if (!result.success && result.errorCode !== undefined) {
    console.error(
      `[Soroban] sorobanRecordBallot failed — ${SorobanErrorCode[result.errorCode]}: ${result.errorMessage}`,
    );
  }
  return result;
}

/**
 * Record a token issuance on-chain.
 * Returns the full SorobanInvokeResult — see sorobanRecordBallot doc.
 */
export async function sorobanRecordToken(
  config: SorobanConfig,
  ballotIdHash: string,
): Promise<SorobanInvokeResult> {
  const configCheck = validateSorobanConfig(config);
  if (!configCheck.valid) {
    console.warn(`[Soroban] sorobanRecordToken: ${configCheck.error.message}`);
    return { txHash: "", success: false, ...makeError(SorobanErrorCode.NotConfigured) };
  }
  const caller = StellarSdk.Keypair.fromSecret(config.stellarSecretKey).publicKey();
  const result = await invokeContract(config, "record_token", [
    { value: caller, type: "address" },
    { value: ballotIdHash, type: "string" },
  ]);
  if (!result.success) {
    if (result.errorCode === SorobanErrorCode.BallotNotFound) {
      console.error(
        `[Soroban] sorobanRecordToken: ballot ${ballotIdHash} not found on-chain — BallotNotFound`,
      );
    } else if (result.errorCode !== undefined) {
      console.error(
        `[Soroban] sorobanRecordToken failed — ${SorobanErrorCode[result.errorCode]}: ${result.errorMessage}`,
      );
    }
  }
  return result;
}

/**
 * Record a vote cast on-chain.
 * Returns the full SorobanInvokeResult — see sorobanRecordBallot doc.
 */
export async function sorobanRecordVote(
  config: SorobanConfig,
  ballotIdHash: string,
): Promise<SorobanInvokeResult> {
  const configCheck = validateSorobanConfig(config);
  if (!configCheck.valid) {
    console.warn(`[Soroban] sorobanRecordVote: ${configCheck.error.message}`);
    return { txHash: "", success: false, ...makeError(SorobanErrorCode.NotConfigured) };
  }
  const caller = StellarSdk.Keypair.fromSecret(config.stellarSecretKey).publicKey();
  const result = await invokeContract(config, "record_vote", [
    { value: caller, type: "address" },
    { value: ballotIdHash, type: "string" },
  ]);
  if (!result.success) {
    if (result.errorCode === SorobanErrorCode.BallotNotFound) {
      console.error(
        `[Soroban] sorobanRecordVote: ballot ${ballotIdHash} not found on-chain — BallotNotFound`,
      );
    } else if (result.errorCode !== undefined) {
      console.error(
        `[Soroban] sorobanRecordVote failed — ${SorobanErrorCode[result.errorCode]}: ${result.errorMessage}`,
      );
    }
  }
  return result;
}

/**
 * Record a result publication on-chain.
 * Handles ResultAlreadyPublished idempotency: if the same hash is already
 * published, treats the call as success (txHash: "" since no new tx was sent).
 * Returns the full SorobanInvokeResult — see sorobanRecordBallot doc.
 */
export async function sorobanRecordResult(
  config: SorobanConfig,
  ballotIdHash: string,
  resultHash: string,
): Promise<SorobanInvokeResult> {
  const configCheck = validateSorobanConfig(config);
  if (!configCheck.valid) {
    console.warn(`[Soroban] sorobanRecordResult: ${configCheck.error.message}`);
    return { txHash: "", success: false, ...makeError(SorobanErrorCode.NotConfigured) };
  }
  const caller = StellarSdk.Keypair.fromSecret(config.stellarSecretKey).publicKey();
  const result = await invokeContract(config, "record_result", [
    { value: caller, type: "address" },
    { value: ballotIdHash, type: "string" },
    { value: resultHash, type: "string" },
  ]);

  if (!result.success && result.errorCode === SorobanErrorCode.ResultAlreadyPublished) {
    // Check if the on-chain hash matches ours (idempotent re-record)
    const { value: onChainHash } = await readContract(config, "get_result_hash", [
      { value: ballotIdHash, type: "string" },
    ]);
    if (onChainHash === resultHash) {
      console.log(
        `[Soroban] sorobanRecordResult: result already published with matching hash — treating as success`,
      );
      return { txHash: "", success: true, returnValue: onChainHash };
    }
    console.error(
      `[Soroban] sorobanRecordResult: conflicting result already published for ballot ${ballotIdHash}`,
    );
    return result;
  }

  if (!result.success && result.errorCode !== undefined) {
    console.error(
      `[Soroban] sorobanRecordResult failed — ${SorobanErrorCode[result.errorCode]}: ${result.errorMessage}`,
    );
  }
  return result;
}

/**
 * Rotate the contract admin to a new address.
 * Must be called by the current admin.
 * Returns the full SorobanInvokeResult — see sorobanRecordBallot doc.
 */
export async function sorobanRotateAdmin(
  config: SorobanConfig,
  newAdminPublicKey: string,
): Promise<SorobanInvokeResult> {
  const configCheck = validateSorobanConfig(config);
  if (!configCheck.valid) {
    console.warn(`[Soroban] sorobanRotateAdmin: ${configCheck.error.message}`);
    return { txHash: "", success: false, ...makeError(SorobanErrorCode.NotConfigured) };
  }
  const caller = StellarSdk.Keypair.fromSecret(config.stellarSecretKey).publicKey();
  const result = await invokeContract(config, "rotate_admin", [
    { value: caller, type: "address" },
    { value: newAdminPublicKey, type: "address" },
  ]);
  if (!result.success && result.errorCode !== undefined) {
    console.error(
      `[Soroban] sorobanRotateAdmin failed — ${SorobanErrorCode[result.errorCode]}: ${result.errorMessage}`,
    );
  }
  return result;
}

/**
 * Read on-chain audit counts for a ballot (view call — no transaction).
 *
 * get_tokens_issued / get_votes_cast return Option<u32> on the contract side.
 * Soroban encodes None as ScVal::Void, which scValToNative decodes to
 * `undefined` — not `null` — so we normalize that here to a single documented
 * "missing" sentinel (null) rather than leaking the undefined/null mismatch
 * to callers.
 */
export async function sorobanGetAuditCounts(
  config: SorobanConfig,
  ballotIdHash: string,
): Promise<{
  tokensIssued: number | null;
  votesCast: number | null;
  isConsistent: boolean;
} | null> {
  const contractCheck = validateContractId(config.contractId);
  if (!contractCheck.valid) return null;
  const [tokensRes, votesRes, consistentRes] = await Promise.all([
    readContract(config, "get_tokens_issued", [{ value: ballotIdHash, type: "string" }]),
    readContract(config, "get_votes_cast",    [{ value: ballotIdHash, type: "string" }]),
    readContract(config, "is_consistent",     [{ value: ballotIdHash, type: "string" }]),
  ]);
  return {
    tokensIssued: (tokensRes.value ?? null) as number | null,
    votesCast:    (votesRes.value  ?? null) as number | null,
    isConsistent: (consistentRes.value as boolean) ?? false,
  };
}

/**
 * Get complete ballot state snapshot (single read call).
 */
export async function sorobanGetBallotState(
  config: SorobanConfig,
  ballotIdHash: string,
): Promise<BallotStateSnapshot | null> {
  const contractCheck = validateContractId(config.contractId);
  if (!contractCheck.valid) return null;
  const { value } = await readContract(config, "get_ballot_state", [
    { value: ballotIdHash, type: "string" },
  ]);
  return value as BallotStateSnapshot | null;
}