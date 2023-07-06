import Array "mo:base/Array";

module {

 // Memory
    public type Memory_hello = {var name : Text};
    public func memory_hello() : Memory_hello {
        {
            var name = "Neutron";
        };
    };
    

    public class Init(mem:Memory_hello) {

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
