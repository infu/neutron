import Array "mo:core/Array";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Text "mo:core/Text";
import Memory "./memory/evm_wallet/v1";
module {
  // Hyperliquid's native EVM chain, distinct from the 42161 signing context
  // used by HyperCore master actions. HYPE pays onchain recovery transaction gas.
  let hyperEvm : Memory.Network = { chain_id = 999; name = "HyperEVM"; native_symbol = "HYPE"; explorer_url = "https://hyperevmscan.io"; testnet = false; finality_description = "HyperEVM shares HyperBFT consensus with HyperCore. Canonical inclusion and RPC safe/finalized heads are observed separately; an EVM forwarding receipt does not prove the later HyperCore credit." };
  let hyperUsdc : Memory.Asset = { chain_id = 999; address = "0xb88339cb7199b77e23db6e890353e22632ba630f"; symbol = "USDC"; decimals = 6 };
  public let networks : [Memory.Network] = [
    { chain_id = 1; name = "Ethereum"; native_symbol = "ETH"; explorer_url = "https://etherscan.io"; testnet = false; finality_description = "Inclusion, safe head, and finalized Ethereum head are checked separately." },
    { chain_id = 42161; name = "Arbitrum One"; native_symbol = "ETH"; explorer_url = "https://arbiscan.io"; testnet = false; finality_description = "Sequencer inclusion is not Ethereum settlement. Safe/finalized RPC heads report the L2 provider's settlement view; they do not establish bridge withdrawal readiness." },
    hyperEvm,
    { chain_id = 11155111; name = "Sepolia"; native_symbol = "ETH"; explorer_url = "https://sepolia.etherscan.io"; testnet = true; finality_description = "Ethereum testnet assets have no intended monetary value." },
  ];
  public let assets : [Memory.Asset] = [
    { chain_id = 1; address = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; symbol = "USDC"; decimals = 6 },
    { chain_id = 42161; address = "0xaf88d065e77c8cc2239327c5edb3a432268e5831"; symbol = "USDC"; decimals = 6 },
    hyperUsdc,
  ];
  public func assetKey(chain : Nat, address : Text) : Text = Nat.toText(chain) # ":" # address;
  public func initialize(mem : Memory.Mem) {
    if (Map.size(mem.networks) == 0) for (network in networks.vals()) Map.add(mem.networks, Nat.compare, network.chain_id, network);
    if (Map.size(mem.assets) == 0) for (asset in assets.vals()) Map.add(mem.assets, Text.compare, assetKey(asset.chain_id, asset.address), asset);
    // Add the new configuration to restored v1 roots without replacing owner
    // labels, tracked assets, account identity, journals or nonce reservations.
    if (not Map.containsKey(mem.networks, Nat.compare, hyperEvm.chain_id)) Map.add(mem.networks, Nat.compare, hyperEvm.chain_id, hyperEvm);
    let key = assetKey(hyperUsdc.chain_id, hyperUsdc.address);
    if (not Map.containsKey(mem.assets, Text.compare, key)) Map.add(mem.assets, Text.compare, key, hyperUsdc);
  };
};
