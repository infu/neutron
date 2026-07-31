import Memory "./memory/hello/v1";

module {

    public type AppBackendEnvironment = {
        stable_memory : {
            hello : Memory.Mem;
        };
    };

    public class Init(env : AppBackendEnvironment) {
        let mem = env.stable_memory.hello;

        public func /*update*/hello_world(name : Text) : Text {
            let prev = mem.name;
            mem.name := name;
            prev;
        };
     
    };


    
/*---NEUTRON GENERATED BEGIN---*/

public type hello_world_Input = (name : Text);
public type hello_world_Output = Text;

/*---NEUTRON GENERATED END---*/
}
