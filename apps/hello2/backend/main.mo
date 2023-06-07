

module {


    // Use shared function
    public type Input_use_hello_world = ();
    public type Output_use_hello_world = Text;
    public func use_hello_world(hello_world_func:(()) -> Text, req: Input_use_hello_world) : Output_use_hello_world {
       hello_world_func();
    };
}
