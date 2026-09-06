import Array "mo:core/Array";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Text "mo:core/Text";
import Memory "./memory/evm_wallet/v1";
module {
  public let networks : [Memory.Network] = [
    { chain_id = 1; name = "Ethereum"; native_symbol = "ETH"; explorer_url = "https://etherscan.io"; testnet = false; finality_description = "Inclusion, safe head, and finalized Ethereum head are checked separately." },
    { chain_id = 42161; name = "Arbitrum One"; native_symbol = "ETH"; explorer_url = "https://arbiscan.io"; testnet = false; finality_description = "Sequencer inclusion is not Ethereum settlement. Safe/finalized RPC heads report the L2 provider's settlement view; they do not establish bridge withdrawal readiness." },
    { chain_id = 11155111; name = "Sepolia"; native_symbol = "ETH"; explorer_url = "https://sepolia.etherscan.io"; testnet = true; finality_description = "Ethereum testnet assets have no intended monetary value." },
  ];
  public let assets : [Memory.Asset] = [
    { chain_id = 1; address = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; symbol = "USDC"; decimals = 6 },
    { chain_id = 42161; address = "0xaf88d065e77c8cc2239327c5edb3a432268e5831"; symbol = "USDC"; decimals = 6 },
  ];
  public func assetKey(chain : Nat, address : Text) : Text = Nat.toText(chain) # ":" # address;
  public func initialize(mem : Memory.Mem) {
    if (Map.size(mem.networks) == 0) for (network in networks.vals()) Map.add(mem.networks, Nat.compare, network.chain_id, network);
    if (Map.size(mem.assets) == 0) for (asset in assets.vals()) Map.add(mem.assets, Text.compare, assetKey(asset.chain_id, asset.address), asset);
  };
};
