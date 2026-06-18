//! AnonVote Soroban Smart Contract
//!
//! Records immutable audit events on the Stellar blockchain.
//! Complements the manageData approach with on-chain queryable state.
//!
//! # What this contract does
//! - Records ballot creation events with a ballot ID hash
//! - Records token issuance counts per ballot (no voter identity)
//! - Records vote cast counts per ballot (no vote content)
//! - Records result publication with a tally hash
//! - Allows public verification of event counts on-chain
//!
//! # Privacy guarantees
//! - No voter identifiers stored
//! - No token values stored
//! - No vote content stored
//! - Only counts and hashes — same privacy model as the off-chain system

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, String,
};

// ── Error types ───────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ContractError {
    AdminUnauthorized     = 1,
    AlreadyInitialized    = 2,
    NotInitialized        = 3,
    BallotNotFound        = 4,
    BallotAlreadyExists   = 5,
    ResultAlreadyPublished = 6,
    CounterOverflow       = 7,
    InvalidBallotHash     = 8,
    RateLimitExceeded     = 9,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Operation {
    RecordBallot,
    RecordToken,
    RecordVote,
    RecordResult,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct RateLimit {
    pub calls_per_minute: u32,
    pub calls_per_hour: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct CallCounts {
    pub minute_bucket: u64,
    pub minute_calls: u32,
    pub hour_bucket: u64,
    pub hour_calls: u32,
}

// ── Ballot state types ────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BallotState {
    Active,
    ResultPublished,
}

#[contracttype]
#[derive(Clone)]
pub struct BallotMetadata {
    pub created_at: u64,
    pub admin: Address,
    pub state: BallotState,
}

#[contracttype]
#[derive(Clone)]
pub struct BallotStateSnapshot {
    pub tokens_issued: u32,
    pub votes_cast: u32,
    pub result_hash: Option<String>,
    pub created_at: u64,
    pub admin: Address,
    pub state: BallotState,
}

// ── Storage keys ──────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Admin address — only admin can record events
    Admin,
    /// Timestamp of contract initialization
    InitializedAt,
    /// Token issued count for a ballot: ballot_id_hash → u32
    TokensIssued(String),
    /// Votes cast count for a ballot: ballot_id_hash → u32
    VotesCast(String),
    /// Result hash for a ballot: ballot_id_hash → String
    ResultHash(String),
    /// Whether a ballot has been created: ballot_id_hash → bool
    BallotExists(String),
    /// Ballot metadata: ballot_id_hash → BallotMetadata
    BallotMetadata(String),
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct AnonVoteContract;

#[contractimpl]
impl AnonVoteContract {
    /// Initialize the contract with an admin address.
    /// Must be called once after deployment.
    /// Returns AlreadyInitialized if called again (idempotent-safe).
    pub fn initialize(env: Env, admin: Address) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(ContractError::AlreadyInitialized);
        }
        let default_limit = RateLimit {
            calls_per_minute: 100,
            calls_per_hour: 1000,
        };
        env.storage()
            .instance()
            .set(&(symbol_short!("RateLimit"), Operation::RecordBallot), &default_limit);
        env.storage()
            .instance()
            .set(&(symbol_short!("RateLimit"), Operation::RecordToken), &default_limit);
        env.storage()
            .instance()
            .set(&(symbol_short!("RateLimit"), Operation::RecordVote), &default_limit);
        env.storage()
            .instance()
            .set(&(symbol_short!("RateLimit"), Operation::RecordResult), &default_limit);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::InitializedAt, &env.ledger().timestamp());
        Ok(())
    }

    /// Record a ballot creation event.
    /// ballot_id_hash: SHA-256 hex of the ballot UUID.
    /// Idempotent: if the same caller re-records the same ballot, returns success.
    /// Returns BallotAlreadyExists if a different admin recorded this ballot.
    pub fn record_ballot(
        env: Env,
        caller: Address,
        ballot_id_hash: String,
    ) -> Result<(), ContractError> {
        if ballot_id_hash.len() == 0 {
            return Err(ContractError::InvalidBallotHash);
        }
        caller.require_auth();
        Self::check_rate_limit(&env, &caller, Operation::RecordBallot)?;
        Self::require_admin(&env, &caller)?;

        let exists_key = DataKey::BallotExists(ballot_id_hash.clone());
        if env.storage().persistent().has(&exists_key) {
            // Idempotency: if same admin recorded it, treat as success
            let meta: BallotMetadata = env
                .storage()
                .persistent()
                .get(&DataKey::BallotMetadata(ballot_id_hash))
                .unwrap();
            if meta.admin == caller {
                return Ok(());
            }
            return Err(ContractError::BallotAlreadyExists);
        }

        env.storage().persistent().set(&exists_key, &true);
        env.storage()
            .persistent()
            .set(&DataKey::TokensIssued(ballot_id_hash.clone()), &0u32);
        env.storage()
            .persistent()
            .set(&DataKey::VotesCast(ballot_id_hash.clone()), &0u32);

        let created_at = env.ledger().timestamp();
        let metadata = BallotMetadata {
            created_at,
            admin: caller.clone(),
            state: BallotState::Active,
        };
        env.storage()
            .persistent()
            .set(&DataKey::BallotMetadata(ballot_id_hash.clone()), &metadata);

        env.events().publish(
            (symbol_short!("audit"), symbol_short!("blt_crtd")),
            (ballot_id_hash, created_at, caller),
        );
        Ok(())
    }

    /// Increment the token issued count for a ballot.
    /// Returns CounterOverflow if the count is already at u32::MAX.
    pub fn record_token(
        env: Env,
        caller: Address,
        ballot_id_hash: String,
    ) -> Result<(), ContractError> {
        caller.require_auth();
        Self::check_rate_limit(&env, &caller, Operation::RecordToken)?;
        Self::require_admin(&env, &caller)?;
        Self::require_ballot_exists(&env, &ballot_id_hash)?;

        let key = DataKey::TokensIssued(ballot_id_hash.clone());
        let count: u32 = env.storage().persistent().get(&key).unwrap_or(0);
        if count == u32::MAX {
            env.events().publish(
                (symbol_short!("audit"), symbol_short!("cnt_ovflw")),
                ballot_id_hash,
            );
            return Err(ContractError::CounterOverflow);
        }
        let new_count = count + 1;
        env.storage().persistent().set(&key, &new_count);

        env.events().publish(
            (symbol_short!("audit"), symbol_short!("tok_issd")),
            (ballot_id_hash, new_count),
        );
        Ok(())
    }

    /// Increment the votes cast count for a ballot.
    /// Returns CounterOverflow if the count is already at u32::MAX.
    pub fn record_vote(
        env: Env,
        caller: Address,
        ballot_id_hash: String,
    ) -> Result<(), ContractError> {
        caller.require_auth();
        Self::check_rate_limit(&env, &caller, Operation::RecordVote)?;
        Self::require_admin(&env, &caller)?;
        Self::require_ballot_exists(&env, &ballot_id_hash)?;

        let key = DataKey::VotesCast(ballot_id_hash.clone());
        let count: u32 = env.storage().persistent().get(&key).unwrap_or(0);
        if count == u32::MAX {
            env.events().publish(
                (symbol_short!("audit"), symbol_short!("cnt_ovflw")),
                ballot_id_hash,
            );
            return Err(ContractError::CounterOverflow);
        }
        let new_count = count + 1;
        env.storage().persistent().set(&key, &new_count);

        env.events().publish(
            (symbol_short!("audit"), symbol_short!("vote_cast")),
            (ballot_id_hash, new_count),
        );
        Ok(())
    }

    /// Record the result publication for a ballot.
    /// Idempotent: if the same result_hash is already recorded, returns success.
    /// Returns ResultAlreadyPublished (with a distinguishable error) if a
    /// different result hash was already published.
    pub fn record_result(
        env: Env,
        caller: Address,
        ballot_id_hash: String,
        result_hash: String,
    ) -> Result<(), ContractError> {
        caller.require_auth();
        Self::check_rate_limit(&env, &caller, Operation::RecordResult)?;
        Self::require_admin(&env, &caller)?;
        Self::require_ballot_exists(&env, &ballot_id_hash)?;

        let key = DataKey::ResultHash(ballot_id_hash.clone());
        if let Some(existing) = env.storage().persistent().get::<DataKey, String>(&key) {
            // Idempotent: same hash re-recorded → success
            if existing == result_hash {
                return Ok(());
            }
            return Err(ContractError::ResultAlreadyPublished);
        }

        env.storage().persistent().set(&key, &result_hash.clone());

        let metadata_key = DataKey::BallotMetadata(ballot_id_hash.clone());
        let mut metadata: BallotMetadata =
            env.storage().persistent().get(&metadata_key).unwrap();
        metadata.state = BallotState::ResultPublished;
        env.storage().persistent().set(&metadata_key, &metadata);

        env.events().publish(
            (symbol_short!("audit"), symbol_short!("res_pub")),
            (ballot_id_hash, result_hash),
        );
        Ok(())
    }

    /// Rotate the admin address. Restricted to the current admin.
    /// Emits an audit event with the old and new admin for rotation history.
    pub fn rotate_admin(
        env: Env,
        caller: Address,
        new_admin: Address,
    ) -> Result<(), ContractError> {
        caller.require_auth();
        Self::require_admin(&env, &caller)?;

        env.storage().instance().set(&DataKey::Admin, &new_admin);

        env.events().publish(
            (symbol_short!("audit"), symbol_short!("adm_rotd")),
            (caller, new_admin),
        );
        Ok(())
    }

    /// Set rate limit for a specific operation (admin only).
    pub fn set_rate_limit(
        env: Env,
        caller: Address,
        operation: Operation,
        limit: RateLimit,
    ) -> Result<(), ContractError> {
        caller.require_auth();
        Self::require_admin(&env, &caller)?;
        env.storage()
            .instance()
            .set(&(symbol_short!("RateLimit"), operation), &limit);
        Ok(())
    }

    // ── Read-only queries ────────────────────────────────────────────────────

    /// Get the number of tokens issued for a ballot.
    /// Returns None if the ballot does not exist.
    pub fn get_tokens_issued(env: Env, ballot_id_hash: String) -> Option<u32> {
        if !env
            .storage()
            .persistent()
            .has(&DataKey::BallotExists(ballot_id_hash.clone()))
        {
            return None;
        }
        env.storage()
            .persistent()
            .get(&DataKey::TokensIssued(ballot_id_hash))
    }

    /// Get the number of votes cast for a ballot.
    /// Returns None if the ballot does not exist.
    pub fn get_votes_cast(env: Env, ballot_id_hash: String) -> Option<u32> {
        if !env
            .storage()
            .persistent()
            .has(&DataKey::BallotExists(ballot_id_hash.clone()))
        {
            return None;
        }
        env.storage()
            .persistent()
            .get(&DataKey::VotesCast(ballot_id_hash))
    }

    /// Get the result hash for a ballot (None if not yet published).
    pub fn get_result_hash(env: Env, ballot_id_hash: String) -> Option<String> {
        env.storage()
            .persistent()
            .get(&DataKey::ResultHash(ballot_id_hash))
    }

    /// Check if a ballot has been recorded on-chain.
    pub fn ballot_exists(env: Env, ballot_id_hash: String) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::BallotExists(ballot_id_hash))
    }

    /// Check if a result has been published for a ballot.
    pub fn result_exists(env: Env, ballot_id_hash: String) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::ResultHash(ballot_id_hash))
    }

    /// Get the timestamp when the contract was initialized.
    /// Returns None if the contract has not been initialized.
    pub fn get_initialized_at(env: Env) -> Option<u64> {
        env.storage().instance().get(&DataKey::InitializedAt)
    }

    /// Get ballot metadata (created_at, admin, state).
    /// Returns None if the ballot does not exist.
    pub fn get_ballot_metadata(env: Env, ballot_id_hash: String) -> Option<BallotMetadata> {
        env.storage()
            .persistent()
            .get(&DataKey::BallotMetadata(ballot_id_hash))
    }

    /// Get complete ballot state snapshot (tokens, votes, result, metadata).
    /// Returns None if the ballot does not exist.
    pub fn get_ballot_state(env: Env, ballot_id_hash: String) -> Option<BallotStateSnapshot> {
        if !env
            .storage()
            .persistent()
            .has(&DataKey::BallotExists(ballot_id_hash.clone()))
        {
            return None;
        }

        let tokens_issued: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::TokensIssued(ballot_id_hash.clone()))
            .unwrap_or(0);
        let votes_cast: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::VotesCast(ballot_id_hash.clone()))
            .unwrap_or(0);
        let result_hash: Option<String> = env
            .storage()
            .persistent()
            .get(&DataKey::ResultHash(ballot_id_hash.clone()));
        let metadata: BallotMetadata = env
            .storage()
            .persistent()
            .get(&DataKey::BallotMetadata(ballot_id_hash))
            .unwrap();

        Some(BallotStateSnapshot {
            tokens_issued,
            votes_cast,
            result_hash,
            created_at: metadata.created_at,
            admin: metadata.admin,
            state: metadata.state,
        })
    }

    /// Verify consistency: returns true if tokens_issued == votes_cast.
    pub fn is_consistent(env: Env, ballot_id_hash: String) -> bool {
        let tokens: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::TokensIssued(ballot_id_hash.clone()))
            .unwrap_or(0);
        let votes: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::VotesCast(ballot_id_hash))
            .unwrap_or(0);
        tokens == votes
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    fn require_admin(env: &Env, caller: &Address) -> Result<(), ContractError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ContractError::NotInitialized)?;
        if *caller != admin {
            return Err(ContractError::AdminUnauthorized);
        }
        Ok(())
    }

    fn require_ballot_exists(env: &Env, ballot_id_hash: &String) -> Result<(), ContractError> {
        if !env
            .storage()
            .persistent()
            .has(&DataKey::BallotExists(ballot_id_hash.clone()))
        {
            return Err(ContractError::BallotNotFound);
        }
        Ok(())
    }

    fn check_rate_limit(
        env: &Env,
        caller: &Address,
        operation: Operation,
    ) -> Result<(), ContractError> {
        let now = env.ledger().timestamp();
        let minute_bucket = now / 60;
        let hour_bucket = now / 3600;

        let limit: RateLimit = env
            .storage()
            .instance()
            .get(&(symbol_short!("RateLimit"), operation.clone()))
            .unwrap();

        let counts_key = (symbol_short!("CallCnt"), caller.clone(), operation);
        let mut counts = env
            .storage()
            .persistent()
            .get(&counts_key)
            .unwrap_or(CallCounts {
                minute_bucket: 0,
                minute_calls: 0,
                hour_bucket: 0,
                hour_calls: 0,
            });

        if counts.minute_bucket != minute_bucket {
            counts.minute_bucket = minute_bucket;
            counts.minute_calls = 0;
        }
        if counts.hour_bucket != hour_bucket {
            counts.hour_bucket = hour_bucket;
            counts.hour_calls = 0;
        }

        if counts.minute_calls >= limit.calls_per_minute
            || counts.hour_calls >= limit.calls_per_hour
        {
            return Err(ContractError::RateLimitExceeded);
        }

        counts.minute_calls += 1;
        counts.hour_calls += 1;
        env.storage().persistent().set(&counts_key, &counts);

        Ok(())
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env, String};

    fn setup() -> (Env, AnonVoteContractClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, AnonVoteContract);
        let client = AnonVoteContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin).unwrap();
        (env, client, admin)
    }

    fn setup_with_id() -> (Env, Address, AnonVoteContractClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, AnonVoteContract);
        let client = AnonVoteContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin).unwrap();
        (env, contract_id, client, admin)
    }

    // ── Existing success-path tests ──────────────────────────────────────────

    #[test]
    fn test_record_ballot_and_query() {
        let (env, client, admin) = setup();
        let ballot_hash = String::from_str(&env, "abc123");
        client.record_ballot(&admin, &ballot_hash).unwrap();
        assert!(client.ballot_exists(&ballot_hash));
        assert_eq!(client.get_tokens_issued(&ballot_hash), Some(0));
        assert_eq!(client.get_votes_cast(&ballot_hash), Some(0));
    }

    #[test]
    fn test_token_and_vote_counts() {
        let (env, client, admin) = setup();
        let ballot_hash = String::from_str(&env, "abc123");
        client.record_ballot(&admin, &ballot_hash).unwrap();
        client.record_token(&admin, &ballot_hash).unwrap();
        client.record_token(&admin, &ballot_hash).unwrap();
        client.record_vote(&admin, &ballot_hash).unwrap();
        assert_eq!(client.get_tokens_issued(&ballot_hash), Some(2));
        assert_eq!(client.get_votes_cast(&ballot_hash), Some(1));
        assert!(!client.is_consistent(&ballot_hash));
        client.record_vote(&admin, &ballot_hash).unwrap();
        assert!(client.is_consistent(&ballot_hash));
    }

    #[test]
    fn test_record_result() {
        let (env, client, admin) = setup();
        let ballot_hash = String::from_str(&env, "abc123");
        let result_hash = String::from_str(&env, "deadbeef");
        client.record_ballot(&admin, &ballot_hash).unwrap();
        client
            .record_result(&admin, &ballot_hash, &result_hash)
            .unwrap();
        assert_eq!(client.get_result_hash(&ballot_hash), Some(result_hash));
    }

    #[test]
    fn test_ballot_metadata() {
        let (env, client, admin) = setup();
        let ballot_hash = String::from_str(&env, "abc123");
        client.record_ballot(&admin, &ballot_hash).unwrap();

        let metadata = client.get_ballot_metadata(&ballot_hash).unwrap();
        assert_eq!(metadata.admin, admin);
        assert_eq!(metadata.state, BallotState::Active);
        assert!(metadata.created_at > 0);
    }

    #[test]
    fn test_ballot_state_snapshot() {
        let (env, client, admin) = setup();
        let ballot_hash = String::from_str(&env, "abc123");
        let result_hash = String::from_str(&env, "deadbeef");

        client.record_ballot(&admin, &ballot_hash).unwrap();
        client.record_token(&admin, &ballot_hash).unwrap();
        client.record_token(&admin, &ballot_hash).unwrap();
        client.record_vote(&admin, &ballot_hash).unwrap();
        client
            .record_result(&admin, &ballot_hash, &result_hash)
            .unwrap();

        let state = client.get_ballot_state(&ballot_hash).unwrap();
        assert_eq!(state.tokens_issued, 2);
        assert_eq!(state.votes_cast, 1);
        assert_eq!(state.result_hash, Some(result_hash));
        assert_eq!(state.admin, admin);
        assert_eq!(state.state, BallotState::ResultPublished);
    }

    #[test]
    fn test_nonexistent_ballot() {
        let (env, client, _admin) = setup();
        let ballot_hash = String::from_str(&env, "nonexistent");
        assert_eq!(client.get_tokens_issued(&ballot_hash), None);
        assert_eq!(client.get_votes_cast(&ballot_hash), None);
        assert_eq!(client.get_ballot_metadata(&ballot_hash), None);
        assert_eq!(client.get_ballot_state(&ballot_hash), None);
    }

    // ── Error-case tests ─────────────────────────────────────────────────────

    #[test]
    fn test_initialize_twice_returns_already_initialized() {
        let (_, client, admin) = setup();
        let err = client.try_initialize(&admin).unwrap_err().unwrap();
        assert_eq!(err, ContractError::AlreadyInitialized);
    }

    #[test]
    fn test_initialization_timestamp_stored() {
        let (_, client, _) = setup();
        assert!(client.get_initialized_at().is_some());
        assert!(client.get_initialized_at().unwrap() > 0);
    }

    #[test]
    fn test_unauthorized_caller_returns_admin_unauthorized() {
        let (env, client, _admin) = setup();
        let ballot_hash = String::from_str(&env, "abc123");
        let attacker = Address::generate(&env);
        let err = client
            .try_record_ballot(&attacker, &ballot_hash)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, ContractError::AdminUnauthorized);
    }

    #[test]
    fn test_record_ballot_idempotent_same_admin() {
        let (env, client, admin) = setup();
        let ballot_hash = String::from_str(&env, "abc123");
        client.record_ballot(&admin, &ballot_hash).unwrap();
        // Second call with same admin → idempotent success
        client.record_ballot(&admin, &ballot_hash).unwrap();
    }

    #[test]
    fn test_record_ballot_different_admin_returns_already_exists() {
        let (env, client, admin) = setup();
        let ballot_hash = String::from_str(&env, "abc123");
        client.record_ballot(&admin, &ballot_hash).unwrap();

        // Rotate admin so we have a different valid admin
        let new_admin = Address::generate(&env);
        client.rotate_admin(&admin, &new_admin).unwrap();

        let err = client
            .try_record_ballot(&new_admin, &ballot_hash)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, ContractError::BallotAlreadyExists);
    }

    #[test]
    fn test_counter_overflow_token() {
        let (env, contract_id, client, admin) = setup_with_id();
        let ballot_hash = String::from_str(&env, "abc123");
        client.record_ballot(&admin, &ballot_hash).unwrap();

        // Force counter to u32::MAX inside the contract's storage context
        let bh = ballot_hash.clone();
        env.as_contract(&contract_id, || {
            env.storage()
                .persistent()
                .set(&DataKey::TokensIssued(bh), &u32::MAX);
        });

        let err = client
            .try_record_token(&admin, &ballot_hash)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, ContractError::CounterOverflow);
    }

    #[test]
    fn test_counter_overflow_vote() {
        let (env, contract_id, client, admin) = setup_with_id();
        let ballot_hash = String::from_str(&env, "abc123");
        client.record_ballot(&admin, &ballot_hash).unwrap();

        let bh = ballot_hash.clone();
        env.as_contract(&contract_id, || {
            env.storage()
                .persistent()
                .set(&DataKey::VotesCast(bh), &u32::MAX);
        });

        let err = client
            .try_record_vote(&admin, &ballot_hash)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, ContractError::CounterOverflow);
    }

    #[test]
    fn test_record_result_idempotent_same_hash() {
        let (env, client, admin) = setup();
        let ballot_hash = String::from_str(&env, "abc123");
        let result_hash = String::from_str(&env, "deadbeef");
        client.record_ballot(&admin, &ballot_hash).unwrap();
        client
            .record_result(&admin, &ballot_hash, &result_hash)
            .unwrap();
        // Same hash again → idempotent success
        client
            .record_result(&admin, &ballot_hash, &result_hash)
            .unwrap();
    }

    #[test]
    fn test_record_result_different_hash_returns_already_published() {
        let (env, client, admin) = setup();
        let ballot_hash = String::from_str(&env, "abc123");
        let result_hash = String::from_str(&env, "deadbeef");
        let other_hash = String::from_str(&env, "cafebabe");
        client.record_ballot(&admin, &ballot_hash).unwrap();
        client
            .record_result(&admin, &ballot_hash, &result_hash)
            .unwrap();

        let err = client
            .try_record_result(&admin, &ballot_hash, &other_hash)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, ContractError::ResultAlreadyPublished);
    }

    #[test]
    fn test_result_exists() {
        let (env, client, admin) = setup();
        let ballot_hash = String::from_str(&env, "abc123");
        let result_hash = String::from_str(&env, "deadbeef");
        client.record_ballot(&admin, &ballot_hash).unwrap();
        assert!(!client.result_exists(&ballot_hash));
        client
            .record_result(&admin, &ballot_hash, &result_hash)
            .unwrap();
        assert!(client.result_exists(&ballot_hash));
    }

    #[test]
    fn test_rotate_admin() {
        let (env, client, admin) = setup();
        let new_admin = Address::generate(&env);
        client.rotate_admin(&admin, &new_admin).unwrap();

        // Old admin can no longer record
        let ballot_hash = String::from_str(&env, "abc123");
        let err = client
            .try_record_ballot(&admin, &ballot_hash)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, ContractError::AdminUnauthorized);

        // New admin can record
        client.record_ballot(&new_admin, &ballot_hash).unwrap();
    }

    #[test]
    fn test_rotate_admin_unauthorized() {
        let (env, client, _admin) = setup();
        let attacker = Address::generate(&env);
        let new_admin = Address::generate(&env);
        let err = client
            .try_rotate_admin(&attacker, &new_admin)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, ContractError::AdminUnauthorized);
    }

    #[test]
    fn test_ballot_not_found_on_record_token() {
        let (env, client, admin) = setup();
        let ballot_hash = String::from_str(&env, "missing");
        let err = client
            .try_record_token(&admin, &ballot_hash)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, ContractError::BallotNotFound);
    }

    #[test]
    fn test_invalid_ballot_hash() {
        let (env, client, admin) = setup();
        let empty = String::from_str(&env, "");
        let err = client
            .try_record_ballot(&admin, &empty)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, ContractError::InvalidBallotHash);
    }

    #[test]
    fn test_rate_limit_exceeded() {
        let (env, contract_id, client, admin) = setup_with_id();
        let ballot_hash = String::from_str(&env, "abc123");

        let limit = RateLimit {
            calls_per_minute: 2,
            calls_per_hour: 100,
        };
        client.set_rate_limit(&admin, Operation::RecordToken, &limit).unwrap();

        client.record_ballot(&admin, &ballot_hash).unwrap();
        client.record_token(&admin, &ballot_hash).unwrap();
        client.record_token(&admin, &ballot_hash).unwrap();

        let err = client
            .try_record_token(&admin, &ballot_hash)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, ContractError::RateLimitExceeded);
    }

    #[test]
    fn test_rate_limit_bucket_resets() {
        let (env, contract_id, client, admin) = setup_with_id();
        let ballot_hash = String::from_str(&env, "abc123");

        let limit = RateLimit {
            calls_per_minute: 2,
            calls_per_hour: 100,
        };
        client.set_rate_limit(&admin, Operation::RecordToken, &limit).unwrap();

        client.record_ballot(&admin, &ballot_hash).unwrap();
        client.record_token(&admin, &ballot_hash).unwrap();
        client.record_token(&admin, &ballot_hash).unwrap();

        // Advance time to next minute bucket
        use soroban_sdk::testutils::Ledger;
        let current_time = env.ledger().timestamp();
        env.ledger().set_timestamp(current_time + 60);

        // Should now succeed
        client.record_token(&admin, &ballot_hash).unwrap();
    }

    #[test]
    fn test_different_operations_have_separate_limits() {
        let (env, contract_id, client, admin) = setup_with_id();
        let ballot_hash = String::from_str(&env, "abc123");

        let token_limit = RateLimit {
            calls_per_minute: 1,
            calls_per_hour: 100,
        };
        let vote_limit = RateLimit {
            calls_per_minute: 2,
            calls_per_hour: 100,
        };
        client.set_rate_limit(&admin, Operation::RecordToken, &token_limit).unwrap();
        client.set_rate_limit(&admin, Operation::RecordVote, &vote_limit).unwrap();

        client.record_ballot(&admin, &ballot_hash).unwrap();
        client.record_token(&admin, &ballot_hash).unwrap();
        client.record_vote(&admin, &ballot_hash).unwrap();
        client.record_vote(&admin, &ballot_hash).unwrap();

        let err = client
            .try_record_token(&admin, &ballot_hash)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, ContractError::RateLimitExceeded);
    }

    #[test]
    fn test_different_callers_have_separate_limits() {
        let (env, contract_id, client, admin) = setup_with_id();
        let ballot_hash = String::from_str(&env, "abc123");

        let limit = RateLimit {
            calls_per_minute: 1,
            calls_per_hour: 100,
        };
        client.set_rate_limit(&admin, Operation::RecordToken, &limit).unwrap();

        client.record_ballot(&admin, &ballot_hash).unwrap();
        client.record_token(&admin, &ballot_hash).unwrap();

        let new_admin = Address::generate(&env);
        client.rotate_admin(&admin, &new_admin).unwrap();

        // New admin should have their own rate limit and be able to call
        client.record_token(&new_admin, &ballot_hash).unwrap();
    }
}
