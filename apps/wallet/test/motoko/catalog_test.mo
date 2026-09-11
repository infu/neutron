import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Catalog "../../backend/Catalog";
import Chainkey "../../backend/chainkey/Client";

// Verified with anonymous mainnet queries on 2026-09-07:
// minter get_minter_info, orchestrator get_orchestrator_info, and ledger metadata.
// See README.md for the source references and observed decimals.
let supported : [(Text, Text, Text, Text)] = [
    ("ckUSDC", "xevnm-gaaaa-aaaar-qafnq-cai", "xrs4b-hiaaa-aaaar-qafoa-cai", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
    ("ckUSDT", "cngnf-vqaaa-aaaar-qag4q-cai", "cefgz-dyaaa-aaaar-qag5a-cai", "0xdAC17F958D2ee523a2206206994597C13D831ec7"),
    ("ckEURC", "pe5t5-diaaa-aaaar-qahwa-cai", "pd4vj-oqaaa-aaaar-qahwq-cai", "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c"),
    ("ckWBTC", "bptq2-faaaa-aaaar-qagxq-cai", "dso6s-wiaaa-aaaar-qagya-cai", "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"),
    ("ckWSTETH", "j2tuh-yqaaa-aaaar-qahcq-cai", "jtq73-oyaaa-aaaar-qahda-cai", "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0"),
    ("ckLINK", "g4tto-rqaaa-aaaar-qageq-cai", "gvqys-hyaaa-aaaar-qagfa-cai", "0x514910771AF9Ca656af840dff83E8264EcF986CA"),
    ("ckUNI", "ilzky-ayaaa-aaaar-qahha-cai", "imymm-naaaa-aaaar-qahhq-cai", "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984"),
    ("ckSHIB", "fxffn-xiaaa-aaaar-qagoa-cai", "fqedz-2qaaa-aaaar-qagoq-cai", "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE"),
    ("ckPEPE", "etik7-oiaaa-aaaar-qagia-cai", "eujml-dqaaa-aaaar-qagiq-cai", "0x6982508145454Ce325dDbE47a25d4ec3d2311933"),
    ("ckXAUT", "nza5v-qaaaa-aaaar-qahzq-cai", "nmhmy-riaaa-aaaar-qah2a-cai", "0x68749665FF8D2d112Fa859AA293F07A622782F38"),
    ("ckOCT", "ebo5g-cyaaa-aaaar-qagla-cai", "egp3s-paaaa-aaaar-qaglq-cai", "0xF5cFBC74057C610c8EF151A439252680AC68c6DC"),
];

for ((symbol, ledgerId, index, contract) in supported.vals()) {
    let ledger = switch (Catalog.find(Principal.fromText(ledgerId))) {
        case (?value) value;
        case null Runtime.trap("Missing supported Ethereum ledger: " # symbol);
    };
    assert ledger.symbol == symbol;
    assert ledger.index == ?index;
    assert ledger.history_kind == #icrc;
    assert Catalog.supportsNetwork(ledger, #internet_computer);
    assert Catalog.supportsNetwork(ledger, #ethereum_mainnet);
    assert ledger.networks.size() == 2;
    let route = switch (ledger.native_route) {
        case (?#ckerc20(value)) value;
        case (_) Runtime.trap("Missing ckERC20 route: " # symbol);
    };
    assert Text.toLower(route.contract) == Text.toLower(contract);
    assert route.minter == "sv3dd-oaaaa-aaaar-qacoa-cai";
    assert route.cketh_ledger == "ss2fx-dyaaa-aaaar-qacoq-cai";
    // Every added route uses the same deposit/withdrawal and gas integration.
    for (method in ["get_minter_info", "get_events", "eip_1559_transaction_price", "withdraw_erc20", "retrieve_eth_status"].vals()) {
        var found = false;
        for (call in Chainkey.requiredCalls(#ckerc20(route)).vals()) {
            if (call.principal == Principal.fromText(route.minter) and call.method == method) found := true;
        };
        assert found;
    };
};

// Fresh wallets include TCYCLES; configured selections are preserved by Main.
assert Catalog.defaultLedgers == [
    "ryjl3-tyaaa-aaaaa-aaaba-cai",
    "mxzaz-hqaaa-aaaar-qaada-cai",
    "xevnm-gaaaa-aaaar-qafnq-cai",
    "um5iw-rqaaa-aaaaq-qaaba-cai",
];

let ?cycles = Catalog.find(Principal.fromText("um5iw-rqaaa-aaaaq-qaaba-cai")) else Runtime.trap("Missing TCYCLES preset");
assert cycles.symbol == "TCYCLES";
