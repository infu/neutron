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
        // Ethereum counterparts already listed in EVM Wallet and Uniswap.
        // Ledger/contract pairs, indexes, and ledger metadata were checked
        // against the live ckETH minter and ledger suite orchestrator on
        // 2026-09-07. Fees and decimals are still read from each ledger.
        {
            principal = "pe5t5-diaaa-aaaar-qahwa-cai";
            index = ?"pd4vj-oqaaa-aaaar-qahwq-cai";
            history_kind = #icrc;
            name = "Chain-key EURC";
            symbol = "ckEURC";
            price_asset = null;
            networks = [#internet_computer, #ethereum_mainnet];
            native_route = ?#ckerc20({
                minter = "sv3dd-oaaaa-aaaar-qacoa-cai";
                contract = "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c";
                cketh_ledger = "ss2fx-dyaaa-aaaar-qacoq-cai";
            });
        },
        {
            principal = "bptq2-faaaa-aaaar-qagxq-cai";
            index = ?"dso6s-wiaaa-aaaar-qagya-cai";
            history_kind = #icrc;
            name = "Chain-key WBTC";
            symbol = "ckWBTC";
            price_asset = null;
            networks = [#internet_computer, #ethereum_mainnet];
            native_route = ?#ckerc20({
                minter = "sv3dd-oaaaa-aaaar-qacoa-cai";
                contract = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
                cketh_ledger = "ss2fx-dyaaa-aaaar-qacoq-cai";
            });
        },
        {
            principal = "j2tuh-yqaaa-aaaar-qahcq-cai";
            index = ?"jtq73-oyaaa-aaaar-qahda-cai";
            history_kind = #icrc;
            name = "Chain-key WSTETH";
            symbol = "ckWSTETH";
            price_asset = null;
            networks = [#internet_computer, #ethereum_mainnet];
            native_route = ?#ckerc20({
                minter = "sv3dd-oaaaa-aaaar-qacoa-cai";
                contract = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
                cketh_ledger = "ss2fx-dyaaa-aaaar-qacoq-cai";
            });
        },
        {
            principal = "g4tto-rqaaa-aaaar-qageq-cai";
            index = ?"gvqys-hyaaa-aaaar-qagfa-cai";
            history_kind = #icrc;
            name = "Chain-key LINK";
            symbol = "ckLINK";
            price_asset = null;
            networks = [#internet_computer, #ethereum_mainnet];
            native_route = ?#ckerc20({
                minter = "sv3dd-oaaaa-aaaar-qacoa-cai";
                contract = "0x514910771AF9Ca656af840dff83E8264EcF986CA";
                cketh_ledger = "ss2fx-dyaaa-aaaar-qacoq-cai";
            });
        },
        {
            principal = "ilzky-ayaaa-aaaar-qahha-cai";
            index = ?"imymm-naaaa-aaaar-qahhq-cai";
            history_kind = #icrc;
            name = "Chain-key UNI";
            symbol = "ckUNI";
            price_asset = null;
            networks = [#internet_computer, #ethereum_mainnet];
            native_route = ?#ckerc20({
                minter = "sv3dd-oaaaa-aaaar-qacoa-cai";
                contract = "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984";
                cketh_ledger = "ss2fx-dyaaa-aaaar-qacoq-cai";
            });
        },
        {
            principal = "fxffn-xiaaa-aaaar-qagoa-cai";
            index = ?"fqedz-2qaaa-aaaar-qagoq-cai";
            history_kind = #icrc;
            name = "Chain-key SHIB";
            symbol = "ckSHIB";
            price_asset = null;
            networks = [#internet_computer, #ethereum_mainnet];
            native_route = ?#ckerc20({
                minter = "sv3dd-oaaaa-aaaar-qacoa-cai";
                contract = "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE";
                cketh_ledger = "ss2fx-dyaaa-aaaar-qacoq-cai";
            });
        },
        {
            principal = "etik7-oiaaa-aaaar-qagia-cai";
            index = ?"eujml-dqaaa-aaaar-qagiq-cai";
            history_kind = #icrc;
            name = "Chain-key PEPE";
            symbol = "ckPEPE";
            price_asset = null;
            networks = [#internet_computer, #ethereum_mainnet];
            native_route = ?#ckerc20({
                minter = "sv3dd-oaaaa-aaaar-qacoa-cai";
                contract = "0x6982508145454Ce325dDbE47a25d4ec3d2311933";
                cketh_ledger = "ss2fx-dyaaa-aaaar-qacoq-cai";
            });
        },
        {
            principal = "nza5v-qaaaa-aaaar-qahzq-cai";
            index = ?"nmhmy-riaaa-aaaar-qah2a-cai";
            history_kind = #icrc;
            name = "Chain-key XAUT";
            symbol = "ckXAUT";
            price_asset = null;
            networks = [#internet_computer, #ethereum_mainnet];
            native_route = ?#ckerc20({
                minter = "sv3dd-oaaaa-aaaar-qacoa-cai";
                contract = "0x68749665FF8D2d112Fa859AA293F07A622782F38";
                cketh_ledger = "ss2fx-dyaaa-aaaar-qacoq-cai";
            });
        },
        {
            principal = "ebo5g-cyaaa-aaaar-qagla-cai";
            index = ?"egp3s-paaaa-aaaar-qaglq-cai";
            history_kind = #icrc;
            name = "Chain-key OCT";
            symbol = "ckOCT";
            price_asset = null;
            networks = [#internet_computer, #ethereum_mainnet];
            native_route = ?#ckerc20({
                minter = "sv3dd-oaaaa-aaaar-qacoa-cai";
                contract = "0xF5cFBC74057C610c8EF151A439252680AC68c6DC";
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
            symbol = "TCYCLES";
            price_asset = null;
            networks = [#internet_computer];
            native_route = null;
        },
    ];

    public let defaultLedgers : [Text] = [
        ICP_LEDGER,
        CKBTC_LEDGER,
        CKUSDC_LEDGER,
        "um5iw-rqaaa-aaaaq-qaaba-cai",
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
