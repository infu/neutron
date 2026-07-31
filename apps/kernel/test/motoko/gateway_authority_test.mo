import GatewayAuthority "../../backend/http_routes/GatewayAuthority";
import RouteNamespace "../../backend/http_routes/Namespace";

let canisterId = "4caro-hl777-77775-aaaba-cai";
let authorities = GatewayAuthority.canisterAuthorities(canisterId);

assert (
    authorities == [
        canisterId # ".icp0.io",
        canisterId # ".localhost:8000",
    ]
);
assert (
    authorities.size() == GatewayAuthority.CANISTER_AUTHORITY_VARIANTS and
    authorities.size() <= GatewayAuthority.CANISTER_AUTHORITY_VARIANTS_MAX
);
assert (RouteNamespace.isSharedAuthority(canisterId, authorities[0]));
assert (RouteNamespace.isSharedAuthority(canisterId, authorities[1]));
assert (not RouteNamespace.isSharedAuthority(
    canisterId,
    canisterId # ".raw.icp0.io",
));
assert (not RouteNamespace.isSharedAuthority(canisterId, "example.icp0.io"));

assert (
    GatewayAuthority.parseCanonical("example.icp0.io:443") ==
    ?{
        authority = "example.icp0.io:443";
        hostname = "example.icp0.io";
        host_label = "example";
        port = ?"443";
        raw_gateway = false;
    }
);
assert (
    GatewayAuthority.parseCanonical("x--" # canisterId # ".raw.icp0.io") ==
    ?{
        authority = "x--" # canisterId # ".raw.icp0.io";
        hostname = "x--" # canisterId # ".raw.icp0.io";
        host_label = "x--" # canisterId;
        port = null;
        raw_gateway = true;
    }
);
assert (GatewayAuthority.parseCanonical("example.icp0.io:0") != null);
assert (GatewayAuthority.parseCanonical("Example.icp0.io") == null);
assert (GatewayAuthority.parseCanonical("example.icp0.io:0443") == null);
assert (GatewayAuthority.parseCanonical("example.icp0.io:65536") == null);
assert (GatewayAuthority.parseCanonical("-example.icp0.io") == null);
assert (GatewayAuthority.parseCanonical("example..icp0.io") == null);
assert (GatewayAuthority.parseCanonical("example.icp0.io.") == null);
assert (GatewayAuthority.parseCanonical("user@example.icp0.io") == null);

assert (
    GatewayAuthority.fromHeaders([
        ("hOsT", canisterId # ".localhost:8000"),
        ("X-Forwarded-Host", "attacker.example"),
    ]) == #present({
        authority = canisterId # ".localhost:8000";
        hostname = canisterId # ".localhost";
        host_label = canisterId;
        port = ?"8000";
        raw_gateway = false;
    })
);
assert (
    GatewayAuthority.fromHeaders([
        ("X-Forwarded-Host", canisterId # ".localhost:8000"),
    ]) == #missing
);
assert (
    GatewayAuthority.fromHeaders([
        ("Host", authorities[0]),
        ("HOST", authorities[0]),
    ]) == #invalid
);
