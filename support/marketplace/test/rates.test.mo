import Test "mo:test";
import Principal "mo:core/Principal";
import Store "../mo/Store";
import Types "../mo/Types";
import Rates "../mo/Rates";
import Journal "../mo/PaymentStore";

persistent actor {
    func fixture() : (Store.DB, Types.TokenConfig) {
        let ledger = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
        let token : Types.TokenConfig = { ledger; symbol = "ckUSDC"; decimals = 6; fee = 10_000; rateSymbol = "USDC"; burnAccount = null };
        let config : Types.Config = {
            admins = []; auditors = []; tokens = [token]; xrc = Principal.fromText("uf6dk-hyaaa-aaaaq-qaaaq-cai");
            fees = { version = 1; updateBase = 0; updateByte = 0; storageByteYear = 0; purchase = 0; withdraw = 0; grant = 0; xrc = 1_000_000_000 };
            referralTerms = { version = 1; discountBps = 1_000; affiliateBps = 3_000; developerBps = 3_000 };
        };
        (Store.Use(Store.init(config)), token);
    };
    func rate(symbol : Text, at : Nat64, value : Nat64) : Rates.ExchangeRate {
        { base_asset = { symbol; class_ = #Cryptocurrency }; quote_asset = { symbol = "USD"; class_ = #FiatCurrency };
          timestamp = at; rate = value; metadata = { decimals = 9; base_asset_num_received_rates = 4; base_asset_num_queried_sources = 5;
            quote_asset_num_received_rates = 3; quote_asset_num_queried_sources = 4; standard_deviation = 1; forex_timestamp = null } };
    };
    public func failed_refresh_keeps_successful_price_indefinitely() : async Test.Metrics {
        Test.test(func () {
            let (db, token) = fixture();
            let (first, _, _) = Rates.retain(db, token, 1, 2, #ok(rate("USDC", 1, 900_000_000)));
            assert first;
            let (changed, retained, error) = Rates.retain(db, token, 1_000_000_000_000_000, 1_000_000_000_000_001, #err("XRC unavailable"));
            assert not changed and error == ?"XRC unavailable";
            let ?saved = retained else { assert false; return };
            assert saved.usdRate == 900_000_000 and saved.observedAtNs == 1_000_000_000;
            assert saved.lastError == ?"XRC unavailable";
        });
    };
    public func initial_failure_never_fabricates_a_price() : async Test.Metrics {
        Test.test(func () {
            let (db, token) = fixture();
            let (_, retained, _) = Rates.retain(db, token, 1, 2, #err("Pending"));
            let ?saved = retained else { assert false; return };
            assert saved.usdRate == 0 and saved.observedAtNs == 0;
            let (_, wrong, _) = Rates.retain(db, token, 3, 4, #ok(rate("BTC", 5, 1_000_000_000)));
            let ?after = wrong else { assert false; return };
            assert after.usdRate == 0;
        });
    };
    public func ledger_fee_errors_refresh_quotes_without_rewriting_attempts() : async Test.Metrics {
        Test.test(func () {
            let (db, token) = fixture();
            let owner = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
            let request : Types.LedgerRequest = { kind = #transfer_from; ledger = token.ledger; spenderSubaccount = null;
                fromAccount = { owner; subaccount = null }; to = { owner = token.ledger; subaccount = null };
                amount = 1_000_000; fee = 10_000; memo = "frozen"; createdAtTimeNs = 1 };
            let id = Journal.must(db.attempts.insert({ owner; operationKind = #purchase; operationId = 1; ordinal = 0; request;
                state = #dispatched; hadUnknown = true; block = null; duplicate = false; lastLedgerError = null; lastError = null;
                createdAtNs = 1; updatedAtNs = 1 }));
            let tariff = Store.config(db).fees;
            let observed = Journal.observe(db, id, #response(#Err(#BadFee({ expected_fee = 20_000 }))), 2);
            assert observed.state == #outcome_unknown and observed.hadUnknown;
            assert observed.request.fee == 10_000 and observed.request.memo == "frozen";
            assert Store.config(db).tokens[0].fee == 20_000;
            assert Store.config(db).fees == tariff;
        });
    };
    public func delayed_refresh_cannot_overwrite_newer_result() : async Test.Metrics {
        Test.test(func () {
            let (db, token) = fixture();
            ignore Rates.retain(db, token, 10, 20, #ok(rate("USDC", 10, 1_000_000_000)));
            let (changed, _, _) = Rates.retain(db, token, 1, 30, #err("old failed call"));
            assert not changed;
            let ?after = Store.getRate(db, token.ledger) else { assert false; return };
            assert after.lastError == null and after.refreshedAtNs == 20;
            ignore Rates.retain(db, token, 40, 50, #ok(rate("USDC", 9, 500_000_000)));
            let ?latest = Store.getRate(db, token.ledger) else { assert false; return };
            assert latest.usdRate == 1_000_000_000 and latest.observedAtNs == 10_000_000_000;
        });
    };
    public func earlier_success_survives_later_refresh_failure() : async Test.Metrics {
        Test.test(func () {
            let (db, token) = fixture();
            ignore Rates.retain(db, token, 20, 30, #err("newer request failed"));
            let (changed, retained, error) = Rates.retain(db, token, 10, 40, #ok(rate("USDC", 10, 1_000_000_000)));
            assert changed and error == null;
            let ?saved = retained else { assert false; return };
            assert saved.usdRate == 1_000_000_000 and saved.lastError == null;
            assert saved.observedAtNs == 10_000_000_000;
            // Conversely, a delayed older successful observation cannot
            // replace a newer successful price.
            ignore Rates.retain(db, token, 50, 60, #ok(rate("USDC", 20, 950_000_000)));
            ignore Rates.retain(db, token, 45, 70, #ok(rate("USDC", 19, 1_100_000_000)));
            let ?latest = Store.getRate(db, token.ledger) else { assert false; return };
            assert latest.usdRate == 950_000_000 and latest.observedAtNs == 20_000_000_000;
        });
    };
}
