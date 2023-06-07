

module {

    public type Input_hello_world = {name:Text};
    public type Output_hello_world = Text;
    public func hello_world(req: Input_hello_world) : Output_hello_world {
        "Hello World - from Neutron app Hello = " # req.name;
    };

    // Share function
    public type Input_hello_local = ();
    public type Output_hello_local = Text;
    public func hello_local(req: Input_hello_local) : Output_hello_local {
        "Hello World Local";
    };
}
