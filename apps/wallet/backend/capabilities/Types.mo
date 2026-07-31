import NeutronCapabilities "mo:neutron-capabilities";

module {
    public type CallRequest = NeutronCapabilities.BackendCallRequestV1;
    public type CallError = NeutronCapabilities.BackendCallErrorV1;
    public type CallResult = NeutronCapabilities.BackendCallResultV1;
    public type BackendCalls = NeutronCapabilities.BackendCallsV1;
    public type TaskCapabilities = {
        backend_calls : BackendCalls;
    };
};
