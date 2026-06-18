/**
 * In-memory stand-in for the deployed AnonVote contract, used only to drive
 * the integration test's mocked RPC responses.
 *
 * IMPORTANT CAVEAT: this mirrors the *return values* of the methods in
 * contracts/anonvote/src/lib.rs (record_ballot, record_token, ... ,
 * is_consistent) closely enough to exercise sorobanService.ts's control flow
 * — error mapping, idempotency, retries. It does NOT execute real WASM, does
 * NOT enforce require_auth(), and applies state during the simulate step for
 * simplicity (real Soroban applies state on tx confirmation, not simulation).
 * Contract correctness itself stays the responsibility of the Rust tests in
 * lib.rs — this fake exists purely so the TS service can be integration-
 * tested without a live network, per the issue's acceptance criteria.
 */

type FakeBallot = {
  admin: string;
  tokensIssued: number;
  votesCast: number;
  resultHash: string | null;
};

export type LedgerOutcome =
  | { ok: true; value?: unknown }
  | { ok: false; contractErrorCode: number };

// Mirrors ContractError in lib.rs
const ContractErrorCode = {
  BallotNotFound: 4,
  BallotAlreadyExists: 5,
  ResultAlreadyPublished: 6,
};

export class FakeLedger {
  private ballots = new Map<string, FakeBallot>();

  call(method: string, args: { value: unknown }[]): LedgerOutcome {
    const get = (i: number) => args[i]?.value;

    switch (method) {
      case "record_ballot": {
        const caller = get(0) as string;
        const ballotIdHash = get(1) as string;
        const existing = this.ballots.get(ballotIdHash);
        if (existing) {
          if (existing.admin === caller) return { ok: true };
          return { ok: false, contractErrorCode: ContractErrorCode.BallotAlreadyExists };
        }
        this.ballots.set(ballotIdHash, {
          admin: caller,
          tokensIssued: 0,
          votesCast: 0,
          resultHash: null,
        });
        return { ok: true };
      }

      case "record_token": {
        const ballot = this.ballots.get(get(1) as string);
        if (!ballot) return { ok: false, contractErrorCode: ContractErrorCode.BallotNotFound };
        ballot.tokensIssued++;
        return { ok: true };
      }

      case "record_vote": {
        const ballot = this.ballots.get(get(1) as string);
        if (!ballot) return { ok: false, contractErrorCode: ContractErrorCode.BallotNotFound };
        ballot.votesCast++;
        return { ok: true };
      }

      case "record_result": {
        const ballot = this.ballots.get(get(1) as string);
        if (!ballot) return { ok: false, contractErrorCode: ContractErrorCode.BallotNotFound };
        const resultHash = get(2) as string;
        if (ballot.resultHash !== null && ballot.resultHash !== resultHash) {
          return { ok: false, contractErrorCode: ContractErrorCode.ResultAlreadyPublished };
        }
        ballot.resultHash = resultHash;
        return { ok: true };
      }

      case "get_tokens_issued": {
        const ballot = this.ballots.get(get(0) as string);
        // None (ballot missing) -> value: undefined, matching Option<u32>::None
        return { ok: true, value: ballot ? ballot.tokensIssued : undefined };
      }

      case "get_votes_cast": {
        const ballot = this.ballots.get(get(0) as string);
        return { ok: true, value: ballot ? ballot.votesCast : undefined };
      }

      case "get_result_hash": {
        const ballot = this.ballots.get(get(0) as string);
        return { ok: true, value: ballot?.resultHash ?? undefined };
      }

      case "is_consistent": {
        const ballot = this.ballots.get(get(0) as string);
        if (!ballot) return { ok: true, value: true }; // 0 == 0, matches lib.rs default
        return { ok: true, value: ballot.tokensIssued === ballot.votesCast };
      }

      default:
        throw new Error(`FakeLedger: unhandled method "${method}"`);
    }
  }

  reset() {
    this.ballots.clear();
  }
}