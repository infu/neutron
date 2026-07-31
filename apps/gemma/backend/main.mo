import Memory "./memory/gemma/v1";

module {

    public type AppBackendEnvironment = {
        stable_memory : {
            gemma : Memory.Mem;
        };
    };

    public class Init(_env : AppBackendEnvironment) {};


/*---NEUTRON GENERATED BEGIN---*/

/*---NEUTRON GENERATED END---*/
}
