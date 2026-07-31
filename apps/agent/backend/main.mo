import Memory "./memory/agent/v1";

module {

    public type AppBackendEnvironment = {
        stable_memory : {
            agent : Memory.Mem;
        };
    };

    public class Init(_env : AppBackendEnvironment) {};


/*---NEUTRON GENERATED BEGIN---*/

/*---NEUTRON GENERATED END---*/
}
