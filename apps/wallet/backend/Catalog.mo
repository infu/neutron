import Principal "mo:core/Principal";

module {
    let ICP_LEDGER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
    let CKBTC_LEDGER = "mxzaz-hqaaa-aaaar-qaada-cai";
    let CKUSDC_LEDGER = "xevnm-gaaaa-aaaar-qafnq-cai";

    public type Network = {
        #internet_computer;
        #bitcoin_mainnet;
        #dogecoin_mainnet;
        #ethereum_mainnet;
        #solana_mainnet;
    };

    public type NativeRoute = {
        #ckbtc : { minter : Text };
        #cketh : { minter : Text };
        #ckerc20 : { minter : Text; contract : Text; cketh_ledger : Text };
        #ckdoge : { minter : Text };
        #cksol : { minter : Text };
    };

    public type HistoryKind = { #icp; #icrc };

    public type PriceAsset = {
        #btc;
        #doge;
        #eth;
        #icp;
        #sol;
        #usdc;
        #usdt;
    };

    public type Ledger = {
        principal : Text;
        index : ?Text;
        history_kind : HistoryKind;
        name : Text;
        symbol : Text;
        price_asset : ?PriceAsset;
        networks : [Network];
        native_route : ?NativeRoute;
    };

    public let ledgers : [Ledger] = [
        // New ICRC ledger entries default to this IC-only network shape. A
        // native route must be added explicitly with its minter integration.
        {
            principal = ICP_LEDGER;
            index = ?"qhbym-qaaaa-aaaaa-aaafq-cai";
            history_kind = #icp;
            name = "Internet Computer";
            symbol = "ICP";
            price_asset = ?#icp;
            networks = [#internet_computer];
            native_route = null;
        },
        {
            principal = CKBTC_LEDGER;
            index = ?"n5wcd-faaaa-aaaar-qaaea-cai";
            history_kind = #icrc;
            name = "Chain-key Bitcoin";
            symbol = "ckBTC";
            price_asset = ?#btc;
            networks = [#internet_computer, #bitcoin_mainnet];
            native_route = ?#ckbtc({ minter = "mqygn-kiaaa-aaaar-qaadq-cai" });
        },
        {
            principal = "ss2fx-dyaaa-aaaar-qacoq-cai";
            index = ?"s3zol-vqaaa-aaaar-qacpa-cai";
            history_kind = #icrc;
            name = "Chain-key Ether";
            symbol = "ckETH";
            price_asset = ?#eth;
            networks = [#internet_computer, #ethereum_mainnet];
            native_route = ?#cketh({ minter = "sv3dd-oaaaa-aaaar-qacoa-cai" });
        },
        {
            principal = CKUSDC_LEDGER;
            index = ?"xrs4b-hiaaa-aaaar-qafoa-cai";
            history_kind = #icrc;
            name = "Chain-key USDC";
            symbol = "ckUSDC";
            price_asset = ?#usdc;
            networks = [#internet_computer, #ethereum_mainnet];
            native_route = ?#ckerc20({
                minter = "sv3dd-oaaaa-aaaar-qacoa-cai";
                contract = "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
                cketh_ledger = "ss2fx-dyaaa-aaaar-qacoq-cai";
            });
        },
        {
            principal = "cngnf-vqaaa-aaaar-qag4q-cai";
            index = ?"cefgz-dyaaa-aaaar-qag5a-cai";
            history_kind = #icrc;
            name = "Chain-key USDT";
            symbol = "ckUSDT";
            price_asset = ?#usdt;
            networks = [#internet_computer, #ethereum_mainnet];
            native_route = ?#ckerc20({
                minter = "sv3dd-oaaaa-aaaar-qacoa-cai";
                contract = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
                cketh_ledger = "ss2fx-dyaaa-aaaar-qacoq-cai";
            });
        },
        {
            principal = "efmc5-wyaaa-aaaar-qb3wa-cai";
            index = ?"ecnej-3aaaa-aaaar-qb3wq-cai";
            history_kind = #icrc;
            name = "Chain-key Dogecoin";
            symbol = "ckDOGE";
            price_asset = ?#doge;
            networks = [#internet_computer, #dogecoin_mainnet];
            native_route = ?#ckdoge({ minter = "eqltq-xqaaa-aaaar-qb3vq-cai" });
        },
        {
            principal = "ls5lp-lqaaa-aaaar-qb5oa-cai";
            index = ?"2ezyf-hqaaa-aaaar-qb6ga-cai";
            history_kind = #icrc;
            name = "Chain-key Solana";
            symbol = "ckSOL";
            price_asset = ?#sol;
            networks = [#internet_computer, #solana_mainnet];
            native_route = ?#cksol({ minter = "lh22c-kyaaa-aaaar-qb5nq-cai" });
        },
        {
            principal = "um5iw-rqaaa-aaaaq-qaaba-cai";
            index = ?"ul4oc-4iaaa-aaaaq-qaabq-cai";
            history_kind = #icrc;
            name = "Cycles";
            symbol = "CYCLES";
            price_asset = null;
            networks = [#internet_computer];
            native_route = null;
        },
    ];

    public let defaultLedgers : [Text] = [
        ICP_LEDGER,
        CKBTC_LEDGER,
        CKUSDC_LEDGER,
    ];

    public func find(principal : Principal) : ?Ledger {
        for (ledger in ledgers.vals()) {
            if (ledger.principal == Principal.toText(principal)) return ?ledger;
        };
        null;
    };

    public func supportsNetwork(ledger : Ledger, network : Network) : Bool {
        for (candidate in ledger.networks.vals()) {
            if (candidate == network) return true;
        };
        false;
    };

    public func networkText(network : Network) : Text {
        switch (network) {
            case (#internet_computer) "internet_computer";
            case (#bitcoin_mainnet) "bitcoin_mainnet";
            case (#dogecoin_mainnet) "dogecoin_mainnet";
            case (#ethereum_mainnet) "ethereum_mainnet";
            case (#solana_mainnet) "solana_mainnet";
        };
    };

    public func priceAssetText(asset : PriceAsset) : Text {
        switch (asset) {
            case (#btc) "BTC";
            case (#doge) "DOGE";
            case (#eth) "ETH";
            case (#icp) "ICP";
            case (#sol) "SOL";
            case (#usdc) "USDC";
            case (#usdt) "USDT";
        };
    };
};
