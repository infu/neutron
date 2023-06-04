
  
// THIS FILE IS AUTOGENERATED
// YOU WILL GET TYPECHECK ERRORS HERE. DON'T EDIT IT
// INSTEAD EDIT YOUR MODULE OR neutron.json
    
  
    

import kernel "main";
    

shared({caller = _installer}) actor class Class() = this {
    
  

    
        
    type Memory_kernel_store = {
        #v1 : kernel.Memory_kernel;
    };

    stable let memory_store_kernel:Memory_kernel_store = #v1(kernel.memory_kernel());

    let #v1(memory_kernel) = memory_store_kernel;
        

        
    public shared({ caller }) func kernel_static(req: kernel.Input_kernel_static) : async kernel.Output_kernel_static {
        assert(module_kernel_is_authorized(caller));
         kernel.kernel_static(memory_kernel,req)
    };
    

    public query({ caller }) func kernel_static_query(req: kernel.Input_kernel_static_query) : async kernel.Output_kernel_static_query {
        assert(module_kernel_is_authorized(caller));
         kernel.kernel_static_query(memory_kernel,req)
    };
    

    public query({ caller }) func http_request(req: kernel.Input_http_request) : async kernel.Output_http_request {
        
         kernel.http_request(memory_kernel,this.http_request_streaming_callback,req)
    };
    

    public query({ caller }) func http_request_streaming_callback(req: kernel.Input_http_request_streaming_callback) : async kernel.Output_http_request_streaming_callback {
        
         kernel.http_request_streaming_callback(memory_kernel,req)
    };
    

    public query({ caller }) func kernel_use_hello_world(req: kernel.Input_kernel_use_hello_world) : async kernel.Output_kernel_use_hello_world {
        assert(module_kernel_is_authorized(caller));
         kernel.kernel_use_hello_world(memory_kernel,module_kernel_hello_world,req)
    };
    

    public shared({ caller }) func kernel_authorized_add(req: kernel.Input_kernel_authorized_add) : async kernel.Output_kernel_authorized_add {
        assert(module_kernel_is_authorized(caller));
         kernel.kernel_authorized_add(memory_kernel,req)
    };
    

    public shared({ caller }) func kernel_authorized_rem(req: kernel.Input_kernel_authorized_rem) : async kernel.Output_kernel_authorized_rem {
        assert(module_kernel_is_authorized(caller));
         kernel.kernel_authorized_rem(memory_kernel,req)
    };
    

    public shared({ caller }) func kernel_install_code(req: kernel.Input_kernel_install_code) : async kernel.Output_kernel_install_code {
        assert(module_kernel_is_authorized(caller));
        await  kernel.kernel_install_code(memory_kernel,this,req)
    };
    
   
        
      private func module_kernel_hello_world(req: kernel.Input_hello_world) : kernel.Output_hello_world {
       kernel.hello_world(memory_kernel,req)
      };
      

      private func module_kernel_is_authorized(req: kernel.Input_is_authorized) : kernel.Output_is_authorized {
       kernel.is_authorized(memory_kernel,req)
      };
      

    
      
    kernel.kernel_authorized_add(memory_kernel, _installer);
}
    