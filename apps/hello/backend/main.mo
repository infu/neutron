

module {

    public type Input_hello_world = {name:Text};
    public type Output_hello_world = Text;
    public func hello_world(req: Input_hello_world) : Output_hello_world {
        "Hello World - from Neutron app Hello = " # req.name;
    };

}
