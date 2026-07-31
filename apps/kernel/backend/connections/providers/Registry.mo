import Set "mo:core/Set";
import Text "mo:core/Text";
import Data "../CatalogData";
import OpenRouter "OpenRouter";
import Provider "Provider";

module {
    public type ProviderDescriptor = Data.ProviderDescriptor;
    public type Entry = {
        descriptor : ProviderDescriptor;
        adapter : Provider.Adapter;
    };

    public func get(provider : Text) : ?Entry {
        if (provider == "openrouter") {
            ?entry("openrouter", OpenRouter.adapter());
        } else {
            null;
        };
    };

    public func validateRequest(
        provider : Text,
        scopes : [Text],
    ) : ?Text {
        let ?candidate = get(provider) else {
            return ?"Unknown connection provider";
        };
        if (scopes.size() > 32) return ?"Too many connection scopes";
        let seen = Set.empty<Text>();
        for (scope in scopes.vals()) {
            if (scope.size() == 0 or scope.size() > 80) {
                return ?"Invalid connection scope";
            };
            if (not containsScope(candidate.descriptor.scopes, scope)) {
                return ?"Connection scope is not supported";
            };
            if (not Set.insert(seen, Text.compare, scope)) {
                return ?"Duplicate connection scope";
            };
        };
        null;
    };

    func entry(id : Text, adapter : Provider.Adapter) : Entry {
        let descriptor = requireDescriptor(id);
        assert (descriptor.authorization_origin == adapter.authorization_origin);
        { descriptor; adapter };
    };

    func requireDescriptor(id : Text) : ProviderDescriptor {
        for (descriptor in Data.providers.vals()) {
            if (descriptor.id == id) return descriptor;
        };
        assert false;
        loop {};
    };

    func containsScope(values : [Data.Scope], expected : Text) : Bool {
        for (value in values.vals()) {
            if (value.id == expected) return true;
        };
        false;
    };
};
