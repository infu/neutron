import Memory "./memory/spreadsheet/v1";

module {
    public type AppBackendEnvironment = {
        stable_memory : {
            spreadsheet : Memory.Mem;
        };
    };

    public class Init(_env : AppBackendEnvironment) {};

/*---NEUTRON GENERATED BEGIN---*/

/*---NEUTRON GENERATED END---*/
}
