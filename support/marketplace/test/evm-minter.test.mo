import Test "mo:test";
import Blob "mo:core/Blob";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Encoding "../mo/Encoding";
import EvmMinter "../mo/EvmMinter";
import Ledger "../mo/Ledger";

persistent actor {
    func ok<T>(result : EvmMinter.Result<T>) : T {
        switch (result) { case (#ok(value)) value; case (#err(error)) Runtime.trap(error) };
    };
    func fails<T>(result : EvmMinter.Result<T>) {
        switch (result) { case (#err(_)) {}; case (#ok(_)) Runtime.trap("Expected validation failure") };
    };
    func info() : EvmMinter.Info {
        { minter_address = ?"0xb25eA1D493B49a1DeD42aC5B1208cC618f9A9B80";
          deposit_with_subaccount_helper_contract_address = ?"0x18901044688D3756C35Ed2b36D93e6a5B8e00E68";
          supported_ckerc20_tokens = ?[{ erc20_contract_address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
            ledger_canister_id = EvmMinter.ckusdcLedger() }] };
    };
    func unusedBalance(_ : Principal, _ : Ledger.Account) : async* EvmMinter.Result<Nat> {
        Runtime.trap("No balance request expected");
    };
    func unusedBlocked(_ : Principal, _ : Text) : async* EvmMinter.Result<Bool> {
        Runtime.trap("No payer request expected");
    };
    func validInfo(target : Principal) : async* EvmMinter.Result<EvmMinter.Info> {
        assert target == EvmMinter.minterCanister();
        #ok(info());
    };

    public func canonical_mapping_and_helper_discovery() : async Test.Metrics {
        Test.test(func() {
            let route = ok(EvmMinter.validateInfo(info()));
            assert route.chainId == 1 and route.minter == EvmMinter.minterCanister();
            assert route.ledger == EvmMinter.ckusdcLedger() and route.decimals == 6;
            assert route.token == EvmMinter.usdcAddress;
            assert route.helper == "0x18901044688d3756c35ed2b36d93e6a5b8e00e68";
            assert route.minterAddress == "0xb25ea1d493b49a1ded42ac5b1208cc618f9a9b80";
            // The authoritative minter can rotate a helper. An existing invoice
            // keeps its saved route; discovery is not tied to today's address.
            let rotated = ok(EvmMinter.validateInfo({ info() with
                deposit_with_subaccount_helper_contract_address = ?"0x1234567890123456789012345678901234567890" }));
            assert rotated.helper == "0x1234567890123456789012345678901234567890";
        });
    };

    public func missing_legacy_or_conflicting_token_routes_are_rejected() : async Test.Metrics {
        Test.test(func() {
            fails(EvmMinter.validateInfo({ info() with deposit_with_subaccount_helper_contract_address = null }));
            fails(EvmMinter.validateInfo({ info() with minter_address = null }));
            fails(EvmMinter.validateInfo({ info() with minter_address = ?"0x0000000000000000000000000000000000000000" }));
            fails(EvmMinter.validateInfo({ info() with deposit_with_subaccount_helper_contract_address = ?"not-a-helper" }));
            fails(EvmMinter.validateInfo({ info() with supported_ckerc20_tokens = null }));
            fails(EvmMinter.validateInfo({ info() with supported_ckerc20_tokens = ?[] }));
            let canonical : EvmMinter.Token = { erc20_contract_address = EvmMinter.usdcAddress; ledger_canister_id = EvmMinter.ckusdcLedger() };
            fails(EvmMinter.validateInfo({ info() with supported_ckerc20_tokens = ?[canonical, canonical] }));
            fails(EvmMinter.validateInfo({ info() with supported_ckerc20_tokens = ?[{ canonical with ledger_canister_id = EvmMinter.minterCanister() }] }));
            fails(EvmMinter.validateInfo({ info() with supported_ckerc20_tokens = ?[canonical, { canonical with erc20_contract_address = "0x1234567890123456789012345678901234567890" }] }));
        });
    };

    public func wire_projection_accepts_official_additional_fields() : async Test.Metrics {
        Test.test(func() {
            let full = { info() with last_observed_block_number = ?(25_948_124 : Nat);
                supported_ckerc20_tokens = ?[{ ckerc20_token_symbol = "ckUSDC";
                    erc20_contract_address = EvmMinter.usdcAddress; ledger_canister_id = EvmMinter.ckusdcLedger() }] };
            let ?decoded = (from_candid(to_candid(full)) : ?EvmMinter.Info) else Runtime.trap("Official record extension did not decode");
            assert ok(EvmMinter.validateInfo(decoded)) == ok(EvmMinter.validateInfo(info()));
        });
    };

    public func principal_encoding_matches_solidity_bytes32() : async Test.Metrics {
        Test.test(func() {
            // Independent known principal-byte vector, including the length
            // byte and all trailing padding expected by the minter parser.
            let account = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
            assert Encoding.hex(EvmMinter.principalWord(account)) == "0a00000000000000020101000000000000000000000000000000000000000000";
            assert EvmMinter.principalWord(account).size() == 32;
            assert Encoding.hex(EvmMinter.principalWord(Principal.fromText("2vxsx-fae"))) == "0104000000000000000000000000000000000000000000000000000000000000";
            let raw : Blob = "\01\02\03\04\05\06\07\08\09\0a\0b\0c\0d\0e\0f\10\11\12\13\14\15\16\17\18\19\1a\1b\1c\02";
            assert Encoding.hex(EvmMinter.principalWord(Principal.fromBlob(raw))) == "1d0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c020000";
        });
    };

    public func discovery_keeps_remote_errors_and_never_uses_fallback_helpers() : async Test.Metrics {
        let successful : EvmMinter.Client = { getInfo = validInfo; isAddressBlocked = unusedBlocked; balanceOf = unusedBalance };
        let route = ok(await* EvmMinter.discover(successful));
        let unavailable : EvmMinter.Client = { successful with getInfo = func(target : Principal) : async* EvmMinter.Result<EvmMinter.Info> {
            assert target == EvmMinter.minterCanister(); #err("test minter unavailable");
        } };
        let failed = await* EvmMinter.discover(unavailable);
        Test.test(func() {
            assert route == ok(EvmMinter.validateInfo(info()));
            assert failed == #err("Cannot read the official USDC deposit route: test minter unavailable");
        });
    };

    public func payer_policy_comes_from_minter_without_owner_or_eoa_assumptions() : async Test.Metrics {
        let route = ok(EvmMinter.validateInfo(info()));
        var checks = 0;
        let allowed : EvmMinter.Client = { getInfo = validInfo; balanceOf = unusedBalance;
            isAddressBlocked = func(target : Principal, address : Text) : async* EvmMinter.Result<Bool> {
                assert target == EvmMinter.minterCanister();
                assert address == route.helper;
                checks += 1; #ok(false);
            } };
        // A syntactically valid contract payer is not rejected locally. Only
        // authoritative minter policy and the exact helper receipt can decide.
        let accepted = await* EvmMinter.verifyPayer(allowed, route, "0x18901044688D3756C35Ed2b36D93e6a5B8e00E68");
        let bad = await* EvmMinter.verifyPayer(allowed, route, "0x12");
        let blocked : EvmMinter.Client = { allowed with isAddressBlocked = func(_ : Principal, _ : Text) : async* EvmMinter.Result<Bool> { #ok(true) } };
        let blockedResult = await* EvmMinter.verifyPayer(blocked, route, route.helper);
        let unavailable : EvmMinter.Client = { allowed with isAddressBlocked = func(_ : Principal, _ : Text) : async* EvmMinter.Result<Bool> { #err("source policy unavailable") } };
        let unknown = await* EvmMinter.verifyPayer(unavailable, route, route.helper);
        Test.test(func() {
            assert accepted == #ok(route.helper) and checks == 1;
            fails(bad); fails(blockedResult);
            assert unknown == #err("Cannot check whether the official minter accepts this Ethereum payer: source policy unavailable");
            fails(EvmMinter.normalizeAddress("0x0000000000000000000000000000000000000000"));
            fails(EvmMinter.normalizeAddress("0x18901044688D3756C35Ed2b36D93e6a5B8e00E6z"));
        });
    };

    public func invoice_balance_preserves_exact_account_and_unknown_vs_zero() : async Test.Metrics {
        let owner = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
        let subaccount : Blob = "\00\01\02\03\04\05\06\07\08\09\0a\0b\0c\0d\0e\0f\10\11\12\13\14\15\16\17\18\19\1a\1b\1c\1d\1e\1f";
        var reads = 0;
        let calls : EvmMinter.Client = { getInfo = validInfo; isAddressBlocked = unusedBlocked;
            balanceOf = func(ledger : Principal, account : Ledger.Account) : async* EvmMinter.Result<Nat> {
                assert ledger == EvmMinter.ckusdcLedger();
                assert account == { owner; subaccount = ?subaccount };
                reads += 1; #ok(0);
            } };
        let observed = await* EvmMinter.invoiceBalance(calls, owner, subaccount);
        let invalid = await* EvmMinter.invoiceBalance(calls, owner, "short");
        let unavailable : EvmMinter.Client = { calls with balanceOf = func(_ : Principal, _ : Ledger.Account) : async* EvmMinter.Result<Nat> { #err("ledger unavailable") } };
        let unknown = await* EvmMinter.invoiceBalance(unavailable, owner, subaccount);
        Test.test(func() {
            assert observed == #ok(0) and reads == 1;
            fails(invalid);
            assert unknown == #err("ledger unavailable");
        });
    };
}
